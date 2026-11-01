// src/core/dlq.js - Dead Letter Queue (DLQ), Exponential Backoff Retry & Task Status Tracking
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MESH_DIR } = require('../config');
const {
  readInbox,
  writeInbox,
  safeWriteJson,
  acquireLockSync,
  releaseLockSync,
  retryNtfsOperationSync,
  sanitizeAgentName
} = require('./mesh');

const DLQ_FILE = process.env.INTERCOM_DLQ_FILE || path.join(MESH_DIR, 'dlq.json');
const DLQ_DIR = process.env.INTERCOM_DLQ_DIR || path.join(MESH_DIR, 'dlq');

function ensureDlqDir() {
  if (!fs.existsSync(DLQ_DIR)) {
    try {
      fs.mkdirSync(DLQ_DIR, { recursive: true });
    } catch {}
  }
}
ensureDlqDir();

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
  if (!fs.existsSync(DLQ_FILE)) return 0;
  let count = 0;
  try {
    const content = fs.readFileSync(DLQ_FILE, 'utf8');
    const items = JSON.parse(content);
    if (Array.isArray(items) && items.length > 0) {
      ensureDlqDir();
      for (const item of items) {
        const id = sanitizeAgentName(String(item.id || `${Date.now()}_${crypto.randomUUID()}`));
        const targetFile = path.join(DLQ_DIR, `${id}.json`);
        if (!fs.existsSync(targetFile)) {
          fs.writeFileSync(targetFile, JSON.stringify(item, null, 2), 'utf8');
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
  ensureDlqDir();
  const items = [];
  const seenIds = new Set();

  // 1. Read discrete DLQ files
  try {
    const files = retryNtfsOperationSync(() => fs.readdirSync(DLQ_DIR));
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.tmp')) continue;
      try {
        const content = fs.readFileSync(path.join(DLQ_DIR, f), 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && parsed.id) {
          items.push(parsed);
          seenIds.add(String(parsed.id));
        }
      } catch {}
    }
  } catch {}

  // 2. Check legacy monolithic file for any un-migrated items
  if (fs.existsSync(DLQ_FILE)) {
    try {
      const content = fs.readFileSync(DLQ_FILE, 'utf8');
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

function writeDlq(items) {
  safeWriteJson(DLQ_FILE, items);
}

/**
 * Enqueues a failed message into discrete DLQ storage under directory CAS lock (#41, #43)
 * @param {object} msgObj 
 * @param {string} failureReason 
 * @returns {object} enqueued entry
 */
function enqueueDlq(msgObj, failureReason) {
  ensureDlqDir();
  return withDlqLockSync(() => {
    const entryId = sanitizeAgentName(String(msgObj.id || `${Date.now()}_${crypto.randomUUID()}`));
    const entry = {
      ...msgObj,
      id: entryId,
      failureReason: failureReason || 'Max delivery attempts exceeded / Target unreachable',
      enqueuedAt: msgObj.enqueuedAt || new Date().toISOString(),
      retries: (msgObj.retries || 0) + 1
    };

    const targetFile = path.join(DLQ_DIR, `${entryId}.json`);
    const tmpFile = path.join(DLQ_DIR, `.tmp_${entryId}_${Date.now()}.tmp`);
    const serialized = JSON.stringify(entry, null, 2);

    // 1. Atomic discrete file write
    retryNtfsOperationSync(() => {
      fs.writeFileSync(tmpFile, serialized, 'utf8');
    });
    retryNtfsOperationSync(() => {
      fs.renameSync(tmpFile, targetFile);
    });

    // 2. Backwards-compatible dlq.json index update
    try {
      const all = getDlq();
      safeWriteJson(DLQ_FILE, all);
    } catch {}

    console.log(`⚠️ [DLQ ENQUEUED] Message #${entry.id} to "${entry.to}" added to Dead Letter Queue (${entry.failureReason})`);
    return entry;
  });
}

/**
 * Clears all dead-letter messages under directory CAS lock
 */
function clearDlq() {
  ensureDlqDir();
  withDlqLockSync(() => {
    try {
      const files = retryNtfsOperationSync(() => fs.readdirSync(DLQ_DIR));
      for (const f of files) {
        if (f.endsWith('.json') || f.startsWith('.tmp')) {
          try {
            retryNtfsOperationSync(() => fs.unlinkSync(path.join(DLQ_DIR, f)));
          } catch {}
        }
      }
    } catch {}

    // Clear legacy monolithic file
    safeWriteJson(DLQ_FILE, []);
  });
}

/**
 * Retrieves a single dead-letter message by ID in O(1) time
 * @param {string} id 
 * @returns {object|null}
 */
function getDlqMessage(id) {
  if (!id) return null;
  const safeId = sanitizeAgentName(String(id));
  const file = path.join(DLQ_DIR, `${safeId}.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  // Check monolithic fallback
  const dlq = getDlq();
  return dlq.find(m => String(m.id) === String(id)) || null;
}

/**
 * Removes a single message from the DLQ by ID under CAS lock
 * @param {string} id 
 * @returns {boolean}
 */
function deleteDlqMessage(id) {
  if (!id) return false;
  return withDlqLockSync(() => {
    const safeId = sanitizeAgentName(String(id));
    const file = path.join(DLQ_DIR, `${safeId}.json`);
    let removed = false;
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        removed = true;
      } catch {}
    }
    // Update dlq.json
    try {
      const all = getDlq().filter(m => String(m.id) !== String(id));
      safeWriteJson(DLQ_FILE, all);
    } catch {}
    return removed;
  });
}

function updateMessageStatus(agentName, msgId, status, result = null) {
  const inbox = readInbox(agentName);
  let updated = false;
  let updatedMsg = null;

  inbox.forEach(m => {
    if (String(m.id) === String(msgId)) {
      m.status = status;
      m.statusUpdatedAt = new Date().toISOString();
      if (result !== null) m.result = result;
      if (status === 'COMPLETED' || status === 'ACKNOWLEDGED') m.read = true;
      updated = true;
      updatedMsg = m;
    }
  });

  if (updated) {
    writeInbox(agentName, inbox);
  }
  return updatedMsg;
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
  DLQ_FILE,
  DLQ_DIR
};
