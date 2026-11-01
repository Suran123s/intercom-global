// test/mesh-batching.test.js - Milestone 2 Batching & LRU Cache Bounding Test Suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  writeMessage,
  writeMessagesBatch,
  writeMessagesBatchSync,
  readInbox,
  readInboxSync,
  clearInbox,
  LruCache,
  getMeshCacheStats,
  clearMeshCache,
  getInboxDir
} = require('../src/core/mesh');
const { MessageEnvelope } = require('../src/core/message');

test('#40: writeMessagesBatch writes multiple discrete envelopes atomically under single directory lock', async () => {
  const agent = 'batch-agent-' + Date.now();
  await clearInbox(agent);

  const batchSize = 25;
  const envelopes = [];
  for (let i = 0; i < batchSize; i++) {
    envelopes.push({
      sender: 'coordinator',
      type: 'task_dispatch',
      payload: { seq: i, note: `Batch item ${i}` }
    });
  }

  const results = await writeMessagesBatch(agent, envelopes);
  assert.strictEqual(results.length, batchSize);

  for (let i = 0; i < batchSize; i++) {
    assert.ok(fs.existsSync(results[i].path), `File must exist: ${results[i].path}`);
    assert.strictEqual(results[i].envelope.payload.seq, i);
  }

  const inbox = readInboxSync(agent);
  assert.strictEqual(inbox.length, batchSize);
  for (let i = 0; i < batchSize; i++) {
    assert.strictEqual(inbox[i].payload.seq, i);
  }

  // Verify empty batch handling
  const emptyRes = await writeMessagesBatch(agent, []);
  assert.deepStrictEqual(emptyRes, []);

  await clearInbox(agent);
});

test('#40: writeMessagesBatchSync executes synchronously and creates discrete valid JSON files', () => {
  const agent = 'sync-batch-agent-' + Date.now();
  const batchSize = 10;
  const envelopes = [];
  for (let i = 0; i < batchSize; i++) {
    envelopes.push({
      sender: 'sync-tester',
      payload: { syncIdx: i }
    });
  }

  const results = writeMessagesBatchSync(agent, envelopes);
  assert.strictEqual(results.length, batchSize);

  const inboxDir = getInboxDir(agent);
  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
  assert.strictEqual(files.length, batchSize);

  // Read all back
  const inbox = readInboxSync(agent);
  assert.strictEqual(inbox.length, batchSize);

  // Clean up
  for (const f of files) {
    fs.unlinkSync(path.join(inboxDir, f));
  }
});

test('#40: High-throughput stress batch write (50 messages) without corruption', async () => {
  const agent = 'stress-batch-' + Date.now();
  const count = 50;
  const envelopes = [];
  for (let i = 0; i < count; i++) {
    envelopes.push(MessageEnvelope.create({
      sender: 'stress-worker',
      recipient: agent,
      payload: { iteration: i, timestamp: Date.now() }
    }));
  }

  const startTime = Date.now();
  const results = await writeMessagesBatch(agent, envelopes);
  const duration = Date.now() - startTime;

  assert.strictEqual(results.length, count);
  assert.ok(duration < 5000, `Batch write took ${duration}ms, expected < 5000ms`);

  const inbox = await readInbox(agent);
  assert.strictEqual(inbox.length, count);

  await clearInbox(agent);
});

test('#44: LruCache enforces maximum entry bounds and updates recency on access', () => {
  const cache = new LruCache(3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.strictEqual(cache.size, 3);

  // Access 'a' to promote it to most recent
  assert.strictEqual(cache.get('a'), 1);

  // Add 'd' -> 'b' should be evicted because 'a' was promoted
  cache.set('d', 4);
  assert.strictEqual(cache.size, 3);
  assert.strictEqual(cache.has('b'), false);
  assert.strictEqual(cache.has('a'), true);
  assert.strictEqual(cache.has('c'), true);
  assert.strictEqual(cache.has('d'), true);

  const stats = cache.getStats();
  assert.strictEqual(stats.evictions, 1);
  assert.strictEqual(stats.hits, 1);
  assert.strictEqual(stats.misses, 0);

  // Test miss
  assert.strictEqual(cache.get('non-existent'), undefined);
  assert.strictEqual(cache.getStats().misses, 1);
});

test('#44: Global Mesh cache statistics and reset operations', () => {
  clearMeshCache();
  const statsBefore = getMeshCacheStats();
  assert.strictEqual(statsBefore.inboxDirCache.size, 0);
  assert.strictEqual(statsBefore.fileEnvelopeCache.size, 0);
  assert.strictEqual(statsBefore.inboxDirCache.maxEntries, 500);
  assert.strictEqual(statsBefore.fileEnvelopeCache.maxEntries, 5000);

  // Write and read to populate cache
  const testAgent = 'cache-test-' + Date.now();
  writeMessagesBatchSync(testAgent, [{ sender: 'cache-probe', payload: { x: 1 } }]);
  readInboxSync(testAgent);

  const statsAfter = getMeshCacheStats();
  assert.ok(statsAfter.inboxDirCache.size >= 1);

  clearMeshCache();
  const statsCleared = getMeshCacheStats();
  assert.strictEqual(statsCleared.inboxDirCache.size, 0);
  assert.strictEqual(statsCleared.fileEnvelopeCache.size, 0);

  clearInbox(testAgent);
});
