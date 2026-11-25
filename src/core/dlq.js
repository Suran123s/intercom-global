// src/core/dlq.js - Dead Letter Queue (DLQ), Exponential Backoff Retry & Task Status Tracking
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getMeshDir } = require('../config');
const {
  readInbox,
  safeWriteJson,
  acquireLockSync,
  releaseLockSync,
  retryNtfsOperationSync,
  atomicWriteFileSync,
  updateDiscreteEnvelopeSync,
  getInboxFile,
  withLockSync,
  sanitizeAgentName,
  sanitizeName
} = require('./mesh');

function getDlqFile() {
  return process.env.INTERCOM_DLQ_FILE || path.join(getMeshDir(), 'dlq.json');
}

function getDlqDir() {
  return process.env.INTERCOM_DLQ_DIR || path.join(getMeshDir(), 'dlq');
}

function ensureDlqDir() {
  const dir = getDlqDir();
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
}

/**
 * Executes a function holding the CAS lock for the dead-letter queue
 */
function withDlqLockSync(fn) {
  const lock = acquireLockSync('dlq_storage', 5000);
  try {
    return fn();
  } finally {
    releaseLockSync(lock);
  }
}

/**
 * Migrates legacy monolithic dlq.json entries into discrete mesh/dlq/<id>.json files
 */
function migrateLegacyDlqSync() {
  const dlqFile = getDlqFile();
  if (!fs.existsSync(dlqFile)) return 0;
  let count = 0;
  try {
    const content = fs.readFileSync(dlqFile, 'utf8');
    const items = JSON.parse(content);
    if (Array.isArray(items) && items.length > 0) {
      const dlqDir = ensureDlqDir();
      for (const item of items) {
        const id = sanitizeAgentName(String(item.id || `${Date.now()}_${crypto.randomUUID()}`));
        const targetFile = path.join(dlqDir, `${id}.json`);
        if (!fs.existsSync(targetFile)) {
          atomicWriteFileSync(targetFile, JSON.stringify(item, null, 2));
          count++;
        }
      }
    }
  } catch {}
  return count;
}

/**
 * Reads all dead-letter messages sorted chronologically by enqueue time.
 * Reads discrete files from mesh/dlq/<id>.json with fallback to monolithic dlq.json.
 * @returns {Array<object>}
 */
function getDlq() {
  const dlqDir = ensureDlqDir();
  const dlqFile = getDlqFile();
  const items = [];
  const seenIds = new Set();

  // 1. Read discrete DLQ files
  try {
    const files = retryNtfsOperationSync(() => fs.readdirSync(dlqDir));
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.tmp')) continue;
      try {
        const content = fs.readFileSync(path.join(dlqDir, f), 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && parsed.id) {
          items.push(parsed);
          seenIds.add(String(parsed.id));
        }
      } catch {}
    }
  } catch {}

  // 2. Check legacy monolithic file for any un-migrated items
  if (fs.existsSync(dlqFile)) {
    try {
      const content = fs.readFileSync(dlqFile, 'utf8');
      const legacy = JSON.parse(content);
      if (Array.isArray(legacy)) {
        for (const item of legacy) {
          if (item && item.id && !seenIds.has(String(item.id))) {
            items.push(item);
            seenIds.add(String(item.id));
          }
        }
      }
    } catch {}
  }

  // Sort chronologically
  items.sort((a, b) => {
    const tA = new Date(a.enqueuedAt || 0).getTime();
    const tB = new Date(b.enqueuedAt || 0).getTime();
    return tA - tB;
  });

  return items;
}

/**
 * Enqueues a failed message into discrete DLQ storage under directory CAS lock (#41, #43)
 * @param {object} msgObj 
 * @param {string} failureReason 
 * @returns {object} enqueued entry
 */
function enqueueDlq(msgObj, failureReason) {
  const dlqDir = ensureDlqDir();
  return withDlqLockSync(() => {
    const entryId = sanitizeAgentName(String(msgObj.id || `${Date.now()}_${crypto.randomUUID()}`));
    const entry = {
      ...msgObj,
      id: entryId,
      failureReason: failureReason || 'Max delivery attempts exceeded / Target unreachable',
      enqueuedAt: msgObj.enqueuedAt || new Date().toISOString(),
      retries: (msgObj.retries || 0) + 1
    };

    const targetFile = path.join(dlqDir, `${entryId}.json`);
    atomicWriteFileSync(targetFile, JSON.stringify(entry, null, 2));

    console.error(`[DLQ ENQUEUED] Message #${entry.id} to "${entry.to}" added to Dead Letter Queue (${entry.failureReason})`);
    return entry;
  });
}

/**
 * Clears all dead-letter messages under directory CAS lock
 */
function clearDlq() {
  const dlqDir = ensureDlqDir();
  const dlqFile = getDlqFile();
  withDlqLockSync(() => {
    try {
      const files = retryNtfsOperationSync(() => fs.readdirSync(dlqDir));
      for (const f of files) {
        if (f.endsWith('.json') || f.startsWith('.tmp')) {
          try {
            retryNtfsOperationSync(() => fs.unlinkSync(path.join(dlqDir, f)));
          } catch {}
        }
      }
    } catch {}

    // Clear legacy monolithic file if present
    if (fs.existsSync(dlqFile)) {
      safeWriteJson(dlqFile, []);
    }
  });
}

/**
 * Retrieves a single dead-letter message by ID in O(1) time
 * @param {string} id 
 * @returns {object|null}
 */
function getDlqMessage(id) {
  if (!id) return null;
  const dlqDir = getDlqDir();
  const safeId = sanitizeAgentName(String(id));
  const file = path.join(dlqDir, `${safeId}.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  // Check monolithic fallback
  const dlqFile = getDlqFile();
  if (fs.existsSync(dlqFile)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(dlqFile, 'utf8'));
      if (Array.isArray(legacy)) {
        return legacy.find(m => String(m.id) === String(id)) || null;
      }
    } catch {}
  }
  return null;
}

/**
 * Removes a single message from the DLQ by ID under CAS lock
 * @param {string} id 
 * @returns {boolean}
 */
function deleteDlqMessage(id) {
  if (!id) return false;
  const dlqDir = getDlqDir();
  const dlqFile = getDlqFile();
  return withDlqLockSync(() => {
    const safeId = sanitizeAgentName(String(id));
    const file = path.join(dlqDir, `${safeId}.json`);
    let removed = false;
    if (fs.existsSync(file)) {
      try {
        retryNtfsOperationSync(() => fs.unlinkSync(file));
        removed = true;
      } catch {}
    }
    // Remove from legacy dlq.json only if it exists and actually contains the item
    if (fs.existsSync(dlqFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(dlqFile, 'utf8'));
        if (Array.isArray(parsed) && parsed.some(m => String(m.id) === String(id))) {
          const filtered = parsed.filter(m => String(m.id) !== String(id));
          safeWriteJson(dlqFile, filtered);
          removed = true;
        }
      } catch {}
    }
    return removed;
  });
}

/**
 * Atomically updates status/result/read fields on a discrete inbox envelope (or legacy fallback).
 * Never mutates cached MessageEnvelope objects in place.
 * @param {string} agentName
 * @param {string} msgId
 * @param {string} status
 * @param {any} [result=null]
 * @returns {object|null}
 */
function updateMessageStatus(agentName, msgId, status, result = null) {
  const applyUpdate = (m) => {
    const next = {
      ...m,
      status,
      statusUpdatedAt: new Date().toISOString()
    };
    if (result !== null) next.result = result;
    if (status === 'COMPLETED' || status === 'ACKNOWLEDGED') {
      next.read = true;
      if (next.metadata && typeof next.metadata === 'object') {
        next.metadata = { ...next.metadata, read: true };
      }
    }
    return next;
  };

  // 1. Try discrete envelope update first (under mailbox CAS lock + cache invalidation)
  try {
    const discreteUpdated = updateDiscreteEnvelopeSync(agentName, msgId, applyUpdate);
    if (discreteUpdated) {
      return discreteUpdated;
    }
  } catch {
    // Fall through to legacy check if agentName is non-discrete (e.g. contains '#')
  }

  // 2. Legacy monolithic mailbox fallback (mesh/<agent>.json)
  const cleanLegacy = sanitizeName(agentName);
  const legacyFile = getInboxFile(cleanLegacy);
  if (!fs.existsSync(legacyFile)) return null;

  return withLockSync(`legacy_${cleanLegacy}`, () => {
    if (!fs.existsSync(legacyFile)) return null;
    try {
      const list = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      if (!Array.isArray(list)) return null;
      let updatedMsg = null;
      const nextList = list.map((m) => {
        if (m && String(m.id) === String(msgId)) {
          updatedMsg = applyUpdate(m);
          return updatedMsg;
        }
        return m;
      });
      if (updatedMsg) {
        safeWriteJson(legacyFile, nextList);
      }
      return updatedMsg;
    } catch {
      return null;
    }
  });
}

function getMessageStatus(agentName, msgId) {
  const inbox = readInbox(agentName);
  const found = inbox.find(m => String(m.id) === String(msgId));
  if (found) return found;

  const dlq = getDlq();
  const inDlq = dlq.find(m => String(m.id) === String(msgId));
  if (inDlq) return { ...inDlq, status: 'DLQ_FAILED' };

  return null;
}

async function retryWithBackoff(taskFn, maxAttempts = 3, initialDelayMs = 1000) {
  let attempt = 0;
  let delay = initialDelayMs;

  while (attempt < maxAttempts) {
    try {
      const result = await taskFn(attempt + 1);
      if (result && result.success) return result;
    } catch (err) {
      // Continue to next attempt
    }
    attempt++;
    if (attempt < maxAttempts) {
      // Exponential backoff with jitter
      const jitter = Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, delay + jitter));
      delay *= 2;
    }
  }
  return { success: false, attempts: attempt, error: 'Max backoff attempts reached' };
}

module.exports = {
  getDlq,
  enqueueDlq,
  clearDlq,
  getDlqMessage,
  deleteDlqMessage,
  migrateLegacyDlqSync,
  withDlqLockSync,
  updateMessageStatus,
  getMessageStatus,
  retryWithBackoff,
  getDlqFile,
  getDlqDir,
  get DLQ_FILE() {
    return getDlqFile();
  },
  get DLQ_DIR() {
    return getDlqDir();
  }
};
