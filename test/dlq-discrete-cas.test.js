// test/dlq-discrete-cas.test.js - Milestone 2 DLQ CAS Locking & Discrete Files Test Suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../src/config');

const TEST_DLQ_DIR = path.join(MESH_DIR, 'dlq_cas_test');
const TEST_DLQ_FILE = path.join(MESH_DIR, 'dlq_cas_test.json');
process.env.INTERCOM_DLQ_DIR = TEST_DLQ_DIR;
process.env.INTERCOM_DLQ_FILE = TEST_DLQ_FILE;

const {
  getDlq,
  enqueueDlq,
  clearDlq,
  getDlqMessage,
  deleteDlqMessage,
  migrateLegacyDlqSync,
  withDlqLockSync,
  DLQ_DIR,
  DLQ_FILE
} = require('../src/core/dlq');
const { safeWriteJson } = require('../src/core/mesh');

test('#41 & #43: DLQ writes discrete files with atomic CAS locks and O(1) lookup', async () => {
  clearDlq();
  assert.strictEqual(getDlq().length, 0);

  assert.ok(fs.existsSync(DLQ_DIR), `DLQ_DIR must exist: ${DLQ_DIR}`);

  // Enqueue 5 failed messages sequentially
  for (let i = 0; i < 5; i++) {
    const entry = enqueueDlq({
      id: `fail-seq-${i}`,
      to: `recipient-${i}`,
      from: 'worker',
      message: `Error message ${i}`
    }, `Failure reason ${i}`);

    assert.strictEqual(entry.id, `fail-seq-${i}`);
    assert.strictEqual(entry.retries, 1);
  }

  const items = getDlq();
  assert.strictEqual(items.length, 5);

  // Verify discrete files on disk
  for (let i = 0; i < 5; i++) {
    const filePath = path.join(DLQ_DIR, `fail-seq-${i}.json`);
    assert.ok(fs.existsSync(filePath), `Discrete DLQ file must exist: ${filePath}`);
    const found = getDlqMessage(`fail-seq-${i}`);
    assert.ok(found, `Must find message fail-seq-${i}`);
    assert.strictEqual(found.to, `recipient-${i}`);
  }

  // Delete single message by ID
  const delRes = deleteDlqMessage('fail-seq-2');
  assert.strictEqual(delRes, true);
  assert.strictEqual(getDlq().length, 4);
  assert.strictEqual(getDlqMessage('fail-seq-2'), null);

  // Clear all
  clearDlq();
  assert.strictEqual(getDlq().length, 0);
  const remainingFiles = fs.readdirSync(DLQ_DIR).filter(f => f.endsWith('.json'));
  assert.strictEqual(remainingFiles.length, 0);
});

test('#41: Concurrent worker enqueueing under CAS directory lock guarantees zero loss', async () => {
  clearDlq();

  const concurrency = 15;
  const workers = [];

  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      return enqueueDlq({
        id: `concurrent-dlq-${i}`,
        to: `agent-${i}`,
        from: 'stress-worker',
        message: `Concurrent failure message ${i}`
      }, `Simulated network drop ${i}`);
    })());
  }

  const results = await Promise.all(workers);
  assert.strictEqual(results.length, concurrency);

  const dlq = getDlq();
  assert.strictEqual(dlq.length, concurrency, `Expected ${concurrency} messages in DLQ, got ${dlq.length}`);

  const ids = new Set(dlq.map(m => m.id));
  assert.strictEqual(ids.size, concurrency);

  clearDlq();
  assert.strictEqual(getDlq().length, 0);
});

test('#43: Backward compatibility & legacy monolithic migration', () => {
  clearDlq();

  // Create legacy monolithic file directly
  const legacyItems = [
    { id: 'legacy-msg-1', to: 'agent-1', from: 'operator', enqueuedAt: '2026-10-31T01:00:00.000Z' },
    { id: 'legacy-msg-2', to: 'agent-2', from: 'operator', enqueuedAt: '2026-10-31T02:00:00.000Z' }
  ];
  safeWriteJson(DLQ_FILE, legacyItems);

  // Reading getDlq() includes legacy items before migration
  const itemsBefore = getDlq();
  assert.strictEqual(itemsBefore.length, 2);

  // Migrate legacy entries to discrete files
  const migrated = migrateLegacyDlqSync();
  assert.strictEqual(migrated, 2);

  assert.ok(fs.existsSync(path.join(DLQ_DIR, 'legacy-msg-1.json')));
  assert.ok(fs.existsSync(path.join(DLQ_DIR, 'legacy-msg-2.json')));

  // Lookup individual legacy message
  const msg1 = getDlqMessage('legacy-msg-1');
  assert.ok(msg1);
  assert.strictEqual(msg1.to, 'agent-1');

  clearDlq();
  assert.strictEqual(getDlq().length, 0);

  try {
    if (fs.existsSync(TEST_DLQ_DIR)) fs.rmSync(TEST_DLQ_DIR, { recursive: true, force: true });
    if (fs.existsSync(TEST_DLQ_FILE)) fs.unlinkSync(TEST_DLQ_FILE);
  } catch {}
  delete process.env.INTERCOM_DLQ_DIR;
  delete process.env.INTERCOM_DLQ_FILE;
});
