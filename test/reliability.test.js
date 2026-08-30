// test/reliability.test.js - Reliability, Auto-Spawn, DLQ, and Task Acknowledgment Tests
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { getDlq, enqueueDlq, clearDlq, updateMessageStatus, getMessageStatus, retryWithBackoff } = require('../src/core/dlq');
const { getProfiles, isEndpointReady } = require('../src/controllers/spawner');
const { getInboxFile, writeInbox } = require('../src/core/mesh');

test('DLQ enqueues and inspects failed tasks with diagnostics', () => {
  clearDlq();
  assert.strictEqual(getDlq().length, 0);

  const sampleFailedMsg = {
    id: 'fail-123',
    from: 'suran',
    to: 'offline-agent',
    message: 'Deploy staging build'
  };

  const enqueued = enqueueDlq(sampleFailedMsg, 'Target agent process was closed');
  assert.strictEqual(enqueued.id, 'fail-123');
  assert.strictEqual(enqueued.failureReason, 'Target agent process was closed');
  assert.strictEqual(enqueued.retries, 1);

  const list = getDlq();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'fail-123');

  clearDlq();
  assert.strictEqual(getDlq().length, 0);
});

test('Task lifecycle tracking: updateMessageStatus and getMessageStatus', () => {
  const agent = 'test-ack-agent-' + Date.now();
  const file = getInboxFile(agent);
  const msgId = 'task-999';

  writeInbox(agent, [{
    id: msgId,
    from: 'coordinator',
    to: agent,
    message: 'Execute database migration',
    status: 'QUEUED',
    read: false
  }]);

  // 1. Check initial status
  let status = getMessageStatus(agent, msgId);
  assert.strictEqual(status.status, 'QUEUED');

  // 2. Mark PROCESSING
  updateMessageStatus(agent, msgId, 'PROCESSING');
  status = getMessageStatus(agent, msgId);
  assert.strictEqual(status.status, 'PROCESSING');

  // 3. Mark COMPLETED with result payload
  updateMessageStatus(agent, msgId, 'COMPLETED', 'Migration executed in 1.4s. 0 errors.');
  status = getMessageStatus(agent, msgId);
  assert.strictEqual(status.status, 'COMPLETED');
  assert.strictEqual(status.result, 'Migration executed in 1.4s. 0 errors.');
  assert.strictEqual(status.read, true);

  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test('Spawner profiles discovery contains standard agent profiles', () => {
  const profiles = getProfiles();
  assert.ok(profiles.opencode);
  assert.strictEqual(profiles.opencode.port, 4096);
  assert.ok(profiles.hermes);
  assert.strictEqual(profiles.hermes.port, 8000);
  assert.ok(profiles.pi);
});

test('retryWithBackoff succeeds on transient failure', async () => {
  let calls = 0;
  const transientTask = async (attempt) => {
    calls++;
    if (attempt < 2) throw new Error('Transient 503 error');
    return { success: true, calls };
  };

  const result = await retryWithBackoff(transientTask, 3, 50);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.calls, 2);
  assert.strictEqual(calls, 2);
});
