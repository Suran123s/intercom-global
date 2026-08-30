// src/core/dlq.js - Dead Letter Queue (DLQ), Exponential Backoff Retry & Task Status Tracking
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../config');
const { readInbox, writeInbox } = require('./mesh');

const DLQ_FILE = path.join(MESH_DIR, 'dlq.json');

function getDlq() {
  if (!fs.existsSync(DLQ_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DLQ_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeDlq(items) {
  const tmp = `${DLQ_FILE}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
    fs.renameSync(tmp, DLQ_FILE);
  } catch {
    try { fs.writeFileSync(DLQ_FILE, JSON.stringify(items, null, 2), 'utf8'); } catch {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function enqueueDlq(msgObj, failureReason) {
  const dlq = getDlq();
  const entry = {
    ...msgObj,
    failureReason: failureReason || 'Max delivery attempts exceeded / Target unreachable',
    enqueuedAt: new Date().toISOString(),
    retries: (msgObj.retries || 0) + 1
  };
  dlq.push(entry);
  writeDlq(dlq);
  console.log(`⚠️ [DLQ ENQUEUED] Message #${msgObj.id} to "${msgObj.to}" added to Dead Letter Queue (${entry.failureReason})`);
  return entry;
}

function clearDlq() {
  writeDlq([]);
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
  updateMessageStatus,
  getMessageStatus,
  retryWithBackoff
};
