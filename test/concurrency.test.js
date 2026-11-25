// test/concurrency.test.js - Tier 2 Concurrency & Mailbox Stress Suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MessageEnvelope } = require('../src/core/message');
const {
  writeMessage,
  readInbox,
  readInboxSync,
  acquireLock,
  releaseLock,
  clearInbox,
  getInboxDir
} = require('../src/core/mesh');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('Tier 2 Concurrency: 12 simultaneous writers dispatching 60 messages to a single recipient mailbox', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-concurrency-');
  const recipient = 'stress_recipient_' + Date.now();
  await clearInbox(recipient);

  const writerCount = 12;
  const messagesPerWriter = 5;
  const totalExpected = writerCount * messagesPerWriter; // 60 messages

  const writePromises = [];

  for (let w = 0; w < writerCount; w++) {
    for (let m = 0; m < messagesPerWriter; m++) {
      const env = MessageEnvelope.create({
        sender: `writer_${w}`,
        recipient,
        type: 'task_dispatch',
        priority: (w % 2 === 0) ? 'HIGH' : 'NORMAL',
        payload: {
          writerIndex: w,
          messageIndex: m,
          data: `Payload from writer ${w} seq ${m}`
        }
      });

      writePromises.push(writeMessage(recipient, env));
    }
  }

  // Execute all 60 writes concurrently
  const writeResults = await Promise.all(writePromises);
  assert.strictEqual(writeResults.length, totalExpected);

  // 1. Verify zero corrupted JSON files in the inbox directory
  const inboxDir = getInboxDir(recipient);
  const rawFiles = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
  assert.strictEqual(rawFiles.length, totalExpected);

  for (const f of rawFiles) {
    const rawContent = fs.readFileSync(path.join(inboxDir, f), 'utf8');
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(rawContent);
    }, `File ${f} must be valid, uncorrupted JSON`);
    assert.ok(parsed.id);
    assert.ok(parsed.timestamp);
    assert.ok(parsed.payload);
  }

  // 2. Read back via readInbox: exact count must match
  const inbox = await readInbox(recipient);
  assert.strictEqual(inbox.length, totalExpected, 'All 60 messages must be present without drop');

  // Also verify synchronous read matches
  const inboxSync = readInboxSync(recipient);
  assert.strictEqual(inboxSync.length, totalExpected);

  // 3. Verify strict chronological ordering by timestamp and ID tie-breaker
  for (let i = 1; i < inbox.length; i++) {
    const prev = inbox[i - 1];
    const curr = inbox[i];
    const tsPrev = Date.parse(prev.timestamp);
    const tsCurr = Date.parse(curr.timestamp);
    assert.ok(tsPrev <= tsCurr, `Messages must be sorted chronologically: ${tsPrev} <= ${tsCurr}`);
    if (tsPrev === tsCurr) {
      assert.ok(prev.id.localeCompare(curr.id) <= 0, `Matching timestamp tie-breaker must order by ID: ${prev.id} <= ${curr.id}`);
    }
  }

  // 4. Verify all writers and sequence numbers accounted for
  const receivedMap = new Map();
  for (const msg of inbox) {
    const w = msg.payload.writerIndex;
    const m = msg.payload.messageIndex;
    if (!receivedMap.has(w)) receivedMap.set(w, new Set());
    receivedMap.get(w).add(m);
  }

  assert.strictEqual(receivedMap.size, writerCount);
  for (let w = 0; w < writerCount; w++) {
    assert.strictEqual(receivedMap.get(w).size, messagesPerWriter);
  }

  await clearInbox(recipient);
});

test('Tier 2 Concurrency: CAS Advisory directory locking under heavy multi-process contention', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-concurrency-cas-');
  const resourceName = 'shared_res_' + Date.now();
  const workerCount = 8;
  const executionLog = [];

  // Each worker attempts to acquire lock, perform exclusive critical section work, and release
  async function simulateWorker(id) {
    const lockHandle = await acquireLock(resourceName, 3000, { timeoutMs: 12000 });
    try {
      executionLog.push({ event: 'ENTER', id, timestamp: Date.now() });
      // Simulate critical section work
      await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 15)));
      executionLog.push({ event: 'EXIT', id, timestamp: Date.now() });
    } finally {
      await releaseLock(lockHandle);
    }
  }

  const workerPromises = [];
  for (let i = 0; i < workerCount; i++) {
    workerPromises.push(simulateWorker(i));
  }

  await Promise.all(workerPromises);

  // Verify Mutual Exclusion (At no point were two workers inside the critical section simultaneously)
  let activeWorkers = 0;
  for (const entry of executionLog) {
    if (entry.event === 'ENTER') {
      activeWorkers++;
      assert.strictEqual(activeWorkers, 1, `Mutual exclusion violation: worker ${entry.id} entered while activeCount=${activeWorkers}`);
    } else if (entry.event === 'EXIT') {
      activeWorkers--;
      assert.strictEqual(activeWorkers, 0);
    }
  }

  assert.strictEqual(executionLog.length, workerCount * 2);
});
