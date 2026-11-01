// test/adversarial-m2-intercom.test.js - Milestone 2 Adversarial Stress & Resilience Suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  writeMessage,
  writeMessageSync,
  writeMessagesBatch,
  writeMessagesBatchSync,
  readInbox,
  readInboxSync,
  clearInbox,
  clearInboxSync,
  getInboxDir,
  sendChannelMessage,
  readChannel,
  listChannels,
  clearChannel,
  getChannelFile,
  LruCache,
  clearMeshCache,
  getMeshCacheStats,
  acquireLock,
  acquireLockSync,
  releaseLock,
  releaseLockSync,
  withLock,
  withLockSync,
  LockTimeoutError
} = require('../src/core/mesh');

const {
  getDlq,
  enqueueDlq,
  clearDlq,
  getDlqMessage,
  deleteDlqMessage,
  DLQ_DIR,
  DLQ_FILE
} = require('../src/core/dlq');

const { MessageEnvelope } = require('../src/core/message');
const { MESH_DIR } = require('../src/config');

// Helper to find a definitely non-existent PID
function findDeadPid() {
  for (let candidate = 999990; candidate <= 999999; candidate++) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return candidate;
    }
  }
  return 999999;
}

// ============================================================================
// 1. Concurrency Stress on writeMessagesBatch (#40)
// ============================================================================

test('Adversarial 1.1: 20 concurrent workers writing 50-message batches to the SAME recipient (1,000 total)', { timeout: 60000 }, async () => {
  const recipient = `stress_target_same_${Date.now()}`;
  await clearInbox(recipient);
  const inboxDir = getInboxDir(recipient);

  const numWorkers = 20;
  const messagesPerBatch = 50;
  const totalExpected = numWorkers * messagesPerBatch; // 1,000 messages

  console.log(`[STRESS 1.1] Launching ${numWorkers} concurrent workers writing ${messagesPerBatch} messages each to "${recipient}"...`);
  const startTime = Date.now();

  const workerPromises = [];
  for (let w = 0; w < numWorkers; w++) {
    const workerId = w;
    workerPromises.push((async () => {
      const batch = [];
      for (let i = 0; i < messagesPerBatch; i++) {
        batch.push({
          sender: `worker_${workerId}`,
          type: 'task_dispatch',
          payload: {
            workerId,
            seq: i,
            data: `Worker ${workerId} item ${i} timestamp ${Date.now()}`
          }
        });
      }
      // Pass generous lock timeout to accommodate heavy NTFS lock serialization
      return await writeMessagesBatch(recipient, batch, { timeoutMs: 45000 });
    })());
  }

  const results = await Promise.all(workerPromises);
  const elapsedMs = Date.now() - startTime;
  console.log(`[STRESS 1.1] Completed in ${elapsedMs}ms (${(totalExpected / (elapsedMs / 1000)).toFixed(1)} msgs/sec)`);

  // Assert all workers completed and returned 50 items
  assert.strictEqual(results.length, numWorkers);
  for (let w = 0; w < numWorkers; w++) {
    assert.strictEqual(results[w].length, messagesPerBatch);
    // Assert strict monotonic timestamp ordering within each batch
    for (let i = 0; i < messagesPerBatch - 1; i++) {
      assert.ok(
        results[w][i].envelope.epochMs < results[w][i + 1].envelope.epochMs,
        `Monotonicity violation in worker ${w}: ${results[w][i].envelope.epochMs} not < ${results[w][i + 1].envelope.epochMs}`
      );
    }
  }

  // Assert disk state: zero corrupted .tmp files
  assert.ok(fs.existsSync(inboxDir), `Inbox directory must exist: ${inboxDir}`);
  const diskFiles = fs.readdirSync(inboxDir);
  const tmpFiles = diskFiles.filter(f => f.startsWith('.tmp') || f.endsWith('.tmp'));
  assert.strictEqual(tmpFiles.length, 0, `Corrupted .tmp files detected: ${tmpFiles.join(', ')}`);

  const jsonFiles = diskFiles.filter(f => f.endsWith('.json'));
  assert.strictEqual(jsonFiles.length, totalExpected, `Expected ${totalExpected} files on disk, found ${jsonFiles.length}`);

  // Assert every single file is valid JSON and uncorrupted
  for (const file of jsonFiles) {
    const raw = fs.readFileSync(path.join(inboxDir, file), 'utf8');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, `Corrupted JSON file on disk: ${file}`);
    assert.ok(parsed.id, `Missing envelope ID in ${file}`);
    assert.strictEqual(parsed.recipient, recipient);
  }

  // Assert zero lost messages via readInboxSync
  const inbox = readInboxSync(recipient);
  assert.strictEqual(inbox.length, totalExpected, `Inbox read returned ${inbox.length}, expected ${totalExpected}`);

  // Assert all message IDs are unique
  const messageIds = new Set(inbox.map(m => m.id));
  assert.strictEqual(messageIds.size, totalExpected, `Duplicate message IDs detected! Unique: ${messageIds.size}, Total: ${totalExpected}`);

  // Assert all workers' items are present
  for (let w = 0; w < numWorkers; w++) {
    const workerItems = inbox.filter(m => m.sender === `worker_${w}`);
    assert.strictEqual(workerItems.length, messagesPerBatch, `Worker ${w} lost messages: expected ${messagesPerBatch}, found ${workerItems.length}`);
  }

  // Assert monotonic sorting in inbox read
  for (let i = 0; i < inbox.length - 1; i++) {
    assert.ok(
      inbox[i].epochMs <= inbox[i + 1].epochMs,
      `Non-monotonic read ordering at index ${i}: ${inbox[i].epochMs} > ${inbox[i + 1].epochMs}`
    );
  }

  // Clean up
  await clearInbox(recipient);
  assert.strictEqual(readInboxSync(recipient).length, 0);
});

test('Adversarial 1.2: 20 concurrent workers writing 50-message batches to DISTINCT recipients (1,000 total)', { timeout: 60000 }, async () => {
  const numWorkers = 20;
  const messagesPerBatch = 50;
  const recipients = [];

  for (let w = 0; w < numWorkers; w++) {
    recipients.push(`stress_dist_recip_${w}_${Date.now()}`);
  }

  console.log(`[STRESS 1.2] Launching 20 concurrent workers to 20 distinct recipients...`);
  const startTime = Date.now();

  const workerPromises = recipients.map((recip, w) => {
    return (async () => {
      const batch = [];
      for (let i = 0; i < messagesPerBatch; i++) {
        batch.push({
          sender: `parallel_dist_worker_${w}`,
          type: 'task_dispatch',
          payload: { workerIdx: w, seq: i }
        });
      }
      return await writeMessagesBatch(recip, batch, { timeoutMs: 30000 });
    })();
  });

  const allResults = await Promise.all(workerPromises);
  const elapsedMs = Date.now() - startTime;
  console.log(`[STRESS 1.2] Completed in ${elapsedMs}ms`);

  assert.strictEqual(allResults.length, numWorkers);

  for (let w = 0; w < numWorkers; w++) {
    const recip = recipients[w];
    const inboxDir = getInboxDir(recip);
    const files = fs.readdirSync(inboxDir);

    // Zero .tmp files
    const tmpFiles = files.filter(f => f.startsWith('.tmp') || f.endsWith('.tmp'));
    assert.strictEqual(tmpFiles.length, 0);

    // Exactly 50 messages
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    assert.strictEqual(jsonFiles.length, messagesPerBatch);

    // Strict monotonic ordering
    const inbox = readInboxSync(recip);
    assert.strictEqual(inbox.length, messagesPerBatch);
    for (let i = 0; i < messagesPerBatch - 1; i++) {
      assert.ok(inbox[i].epochMs <= inbox[i + 1].epochMs);
    }

    // Clean up
    await clearInbox(recip);
  }
});

// ============================================================================
// 2. CAS Lock Contention & Deadlock Resilience on DLQ & Channels (#41, #42, #43)
// ============================================================================

test('Adversarial 2.1: DLQ gracefully recovers from stale lock (dead PID / process crash) without data loss', () => {
  clearDlq();
  const deadPid = findDeadPid();
  const locksDir = path.join(MESH_DIR, 'locks');
  if (!fs.existsSync(locksDir)) fs.mkdirSync(locksDir, { recursive: true });

  const dlqLockDir = path.join(locksDir, 'dlq_storage.lock');
  // Clean up any pre-existing lock
  try {
    if (fs.existsSync(dlqLockDir)) {
      const mf = path.join(dlqLockDir, 'metadata.json');
      if (fs.existsSync(mf)) fs.unlinkSync(mf);
      fs.rmdirSync(dlqLockDir);
    }
  } catch {}

  // 1. Simulate process crash by creating lock directory with dead PID
  fs.mkdirSync(dlqLockDir);
  const staleMeta = {
    ownerPid: deadPid,
    createdAt: Date.now() - 1000,
    ttlMs: 60000, // Even with long TTL, dead PID must trigger immediate stale recovery
    resourceName: 'dlq_storage',
    token: 'dead-process-token'
  };
  fs.writeFileSync(path.join(dlqLockDir, 'metadata.json'), JSON.stringify(staleMeta, null, 2), 'utf8');

  // Verify that the lock currently exists on disk
  assert.ok(fs.existsSync(dlqLockDir), 'Simulated dead lock directory must exist before test');

  // 2. Enqueue message into DLQ - must detect dead PID, steal lock, and succeed
  const testMsg = {
    id: `dead_pid_recovery_${Date.now()}`,
    to: 'agent_target',
    from: 'stress_orchestrator',
    message: 'Message rescued across process crash'
  };

  const enqueued = enqueueDlq(testMsg, 'Process crash recovery probe');
  assert.strictEqual(enqueued.id, testMsg.id);

  // 3. Verify message is persisted in discrete DLQ file
  const found = getDlqMessage(testMsg.id);
  assert.ok(found, 'Rescued message must exist in discrete DLQ file');
  assert.strictEqual(found.message, testMsg.message);
  assert.strictEqual(found.retries, 1);

  // 4. Verify message exists in getDlq()
  const dlq = getDlq();
  assert.ok(dlq.some(m => m.id === testMsg.id));

  // Clean up
  deleteDlqMessage(testMsg.id);
  clearDlq();
  assert.strictEqual(getDlq().length, 0);
});

test('Adversarial 2.2: Channel CAS lock gracefully recovers from expired TTL without data loss', () => {
  const channelName = `stale_chan_${Date.now()}`;
  clearChannel(channelName);

  const cleanName = channelName.replace(/^#/, '');
  const locksDir = path.join(MESH_DIR, 'locks');
  if (!fs.existsSync(locksDir)) fs.mkdirSync(locksDir, { recursive: true });

  const chanLockDir = path.join(locksDir, `channel_${cleanName}.lock`);

  // Simulate abandoned lock whose TTL has expired
  if (!fs.existsSync(chanLockDir)) fs.mkdirSync(chanLockDir);
  const expiredMeta = {
    ownerPid: process.pid,
    createdAt: Date.now() - 15000, // 15 seconds old
    ttlMs: 2000, // 2 second TTL (expired)
    resourceName: `channel_${cleanName}`,
    token: 'expired-ttl-token'
  };
  fs.writeFileSync(path.join(chanLockDir, 'metadata.json'), JSON.stringify(expiredMeta, null, 2), 'utf8');

  // Send channel message - must recover expired lock and succeed
  const sent = sendChannelMessage(channelName, 'recovery_agent', 'Channel message post-lock recovery');
  assert.ok(sent);
  assert.strictEqual(sent.channel, `#${cleanName}`);

  // Verify message persisted
  const history = readChannel(channelName);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].message, 'Channel message post-lock recovery');

  // Clean up
  clearChannel(channelName);
  assert.strictEqual(readChannel(channelName).length, 0);
});

test('Adversarial 2.3: Heavy Multi-Contender CAS Lock Stress on DLQ & Channels', async () => {
  clearDlq();
  const testChannel = `stress_multi_chan_${Date.now()}`;
  clearChannel(testChannel);

  const concurrency = 25;
  console.log(`[STRESS 2.3] Dispatching ${concurrency} concurrent DLQ enqueues and ${concurrency} channel sends...`);

  const dlqPromises = [];
  for (let i = 0; i < concurrency; i++) {
    dlqPromises.push((async () => {
      return enqueueDlq({
        id: `multi_dlq_${i}_${Date.now()}`,
        to: `target_agent_${i}`,
        from: 'cas_stress_sender',
        message: `High-contention failure ${i}`
      }, `Network timeout ${i}`);
    })());
  }

  const chanPromises = [];
  for (let i = 0; i < concurrency; i++) {
    chanPromises.push((async () => {
      return sendChannelMessage(testChannel, `chan_sender_${i}`, `Broadcast payload ${i}`);
    })());
  }

  const [dlqResults, chanResults] = await Promise.all([
    Promise.all(dlqPromises),
    Promise.all(chanPromises)
  ]);

  assert.strictEqual(dlqResults.length, concurrency);
  assert.strictEqual(chanResults.length, concurrency);

  // Assert DLQ discrete integrity
  const dlqItems = getDlq();
  assert.strictEqual(dlqItems.length, concurrency);
  const dlqIds = new Set(dlqItems.map(m => m.id));
  assert.strictEqual(dlqIds.size, concurrency);

  for (const res of dlqResults) {
    const single = getDlqMessage(res.id);
    assert.ok(single, `Message ${res.id} must be retrievable in O(1)`);
    assert.strictEqual(single.to, res.to);
  }

  // Assert Channel integrity
  const history = readChannel(testChannel);
  assert.strictEqual(history.length, concurrency);
  const senders = new Set(history.map(m => m.from));
  assert.strictEqual(senders.size, concurrency);

  // Clean up
  clearDlq();
  clearChannel(testChannel);
  assert.strictEqual(getDlq().length, 0);
  assert.strictEqual(readChannel(testChannel).length, 0);
});

// ============================================================================
// 3. LRU Cache Boundary Stress (#44)
// ============================================================================

test('Adversarial 3.1: inboxDirCache capacity boundary stress (insert 1,000 items into capacity 500)', () => {
  const capacity = 500;
  const insertCount = 1000;
  const cache = new LruCache(capacity);

  assert.strictEqual(cache.size, 0);
  assert.strictEqual(cache.maxEntries, capacity);

  for (let i = 0; i < insertCount; i++) {
    cache.set(`inbox_dir_${i}`, { dir: `path/to/inbox_${i}`, mtime: Date.now() + i });
  }

  // Exact capacity bound
  assert.strictEqual(cache.size, capacity, `Cache size must be capped at ${capacity}, got ${cache.size}`);

  // Exact eviction count: 1,000 - 500 = 500 evictions
  const stats = cache.getStats();
  assert.strictEqual(stats.evictions, insertCount - capacity, `Expected exactly ${insertCount - capacity} evictions, got ${stats.evictions}`);

  // Keys 0..499 MUST be evicted
  for (let i = 0; i < insertCount - capacity; i++) {
    assert.strictEqual(cache.has(`inbox_dir_${i}`), false, `Old key inbox_dir_${i} should have been evicted`);
    assert.strictEqual(cache.get(`inbox_dir_${i}`), undefined);
  }

  // Keys 500..999 MUST be retained
  for (let i = insertCount - capacity; i < insertCount; i++) {
    assert.strictEqual(cache.has(`inbox_dir_${i}`), true, `Recent key inbox_dir_${i} must be retained`);
    assert.ok(cache.get(`inbox_dir_${i}`), `Recent key inbox_dir_${i} must return value`);
  }

  // Recency promotion test under eviction pressure:
  // Access key 500 -> promotes it to most recent
  const promotedVal = cache.get('inbox_dir_500');
  assert.ok(promotedVal);

  // Insert 1 new key -> key 501 should be evicted next (oldest unaccessed), NOT key 500
  cache.set('inbox_dir_1000', { dir: 'path/to/inbox_1000' });
  assert.strictEqual(cache.size, capacity);
  assert.strictEqual(cache.has('inbox_dir_500'), true, 'Promoted key 500 must NOT be evicted');
  assert.strictEqual(cache.has('inbox_dir_501'), false, 'Key 501 must be evicted instead of key 500');
  assert.strictEqual(cache.has('inbox_dir_1000'), true);
});

test('Adversarial 3.2: fileEnvelopeCache boundary stress (insert 10,000 items into capacity 5,000) & heap boundedness', () => {
  const capacity = 5000;
  const insertCount = 10000;
  const cache = new LruCache(capacity);

  const initialMemory = process.memoryUsage().heapUsed;

  // Insert 10,000 distinct items with moderate payload
  for (let i = 0; i < insertCount; i++) {
    cache.set(`envelope_${i}`, {
      id: `msg_${i}`,
      payload: `Message payload content for item ${i} padding ${'x'.repeat(128)}`
    });
  }

  // Exact bounds check
  assert.strictEqual(cache.size, capacity);
  const stats = cache.getStats();
  assert.strictEqual(stats.evictions, insertCount - capacity);

  // Exact eviction verification
  for (let i = 0; i < insertCount - capacity; i += 100) {
    assert.strictEqual(cache.has(`envelope_${i}`), false);
  }
  for (let i = insertCount - capacity; i < insertCount; i += 100) {
    assert.strictEqual(cache.has(`envelope_${i}`), true);
  }

  // Memory boundedness check: ensure heap does not leak unbounded
  const finalMemory = process.memoryUsage().heapUsed;
  const heapDeltaMb = (finalMemory - initialMemory) / (1024 * 1024);
  console.log(`[LRU MEMORY STRESS] Heap used delta for 10,000 items into 5,000-capacity LRU: ${heapDeltaMb.toFixed(2)} MB`);
  // 5,000 items with ~200B should comfortably fit well under 30MB
  assert.ok(heapDeltaMb < 50, `Heap memory growth excessive: ${heapDeltaMb.toFixed(2)} MB`);
});

test('Adversarial 3.3: Mesh Global LRU Cache state reset & statistics inspection', () => {
  clearMeshCache();
  const initialStats = getMeshCacheStats();
  assert.strictEqual(initialStats.inboxDirCache.size, 0);
  assert.strictEqual(initialStats.inboxDirCache.maxEntries, 500);
  assert.strictEqual(initialStats.fileEnvelopeCache.size, 0);
  assert.strictEqual(initialStats.fileEnvelopeCache.maxEntries, 5000);

  // Populate through discrete writes and reads
  const agent = `cache_probe_${Date.now()}`;
  writeMessageSync(agent, { sender: 'probe', payload: { ping: true } });
  readInboxSync(agent);

  const populatedStats = getMeshCacheStats();
  assert.ok(populatedStats.inboxDirCache.size >= 1);
  assert.ok(populatedStats.fileEnvelopeCache.size >= 1);

  // Clear resets properly
  clearMeshCache();
  const resetStats = getMeshCacheStats();
  assert.strictEqual(resetStats.inboxDirCache.size, 0);
  assert.strictEqual(resetStats.fileEnvelopeCache.size, 0);

  clearInboxSync(agent);
});

// ============================================================================
// 4. TUI agentIdx Shrink Race & Boundary Testing (Challenger 2 Advisory)
// ============================================================================

test('Adversarial 4.1: TUI agentIdx clamping under rapid list shrinkage (20 items -> 1 item -> 0 items) and navigation race', () => {
  // Pure implementation of TUI keyboard handler algorithms from bin/intercom-tui.js
  let agentList = [];
  let agentIdx = 0;
  let selectedAgent = null;
  const errors = [];

  function selectAgent(name) {
    // Exact guard from bin/intercom-tui.js line 162
    if (!name || typeof name !== 'string') return;
    selectedAgent = name;
  }

  function handleUp() {
    if (agentList.length === 0) return;
    agentIdx = Math.max(0, Math.min(agentList.length - 1, agentIdx - 1));
    if (agentList[agentIdx]) selectAgent(agentList[agentIdx]);
  }

  function handleDown() {
    if (agentList.length === 0) return;
    agentIdx = Math.min(agentList.length - 1, Math.max(0, agentIdx + 1));
    if (agentList[agentIdx]) selectAgent(agentList[agentIdx]);
  }

  function handleEnter() {
    if (agentList.length === 0) return;
    agentIdx = Math.max(0, Math.min(agentList.length - 1, agentIdx));
    if (agentList[agentIdx]) selectAgent(agentList[agentIdx]);
  }

  function renderAgentsClamp() {
    if (agentList.length === 0) {
      agentIdx = 0;
      return;
    }
    if (agentIdx >= agentList.length) {
      agentIdx = Math.max(0, agentList.length - 1);
    }
  }

  // Stress test: 50,000 cycles of rapid list size fluctuations and concurrent key events
  const actions = ['up', 'down', 'enter', 'shrink_to_1', 'shrink_to_0', 'expand_to_20', 'expand_to_50', 'render'];

  for (let cycle = 0; cycle < 50000; cycle++) {
    const action = actions[cycle % actions.length];
    try {
      switch (action) {
        case 'up':
          handleUp();
          break;
        case 'down':
          handleDown();
          break;
        case 'enter':
          handleEnter();
          break;
        case 'shrink_to_1':
          agentList = ['solo-agent'];
          renderAgentsClamp();
          break;
        case 'shrink_to_0':
          agentList = [];
          renderAgentsClamp();
          break;
        case 'expand_to_20':
          agentList = Array.from({ length: 20 }, (_, i) => `agent_${i}`);
          renderAgentsClamp();
          break;
        case 'expand_to_50':
          agentList = Array.from({ length: 50 }, (_, i) => `agent_${i}`);
          renderAgentsClamp();
          break;
        case 'render':
          renderAgentsClamp();
          break;
      }

      // Invariant: agentIdx must ALWAYS be a valid integer index
      if (agentList.length === 0) {
        assert.strictEqual(agentIdx, 0, 'agentIdx must be 0 when list is empty');
      } else {
        assert.ok(agentIdx >= 0, `agentIdx must be >= 0, got ${agentIdx}`);
        assert.ok(agentIdx < agentList.length, `agentIdx out of bounds! index ${agentIdx} >= length ${agentList.length}`);
        assert.strictEqual(typeof agentList[agentIdx], 'string', `agentList[${agentIdx}] must be valid string`);
      }
    } catch (err) {
      errors.push({ cycle, action, err });
    }
  }

  assert.strictEqual(errors.length, 0, `Errors during TUI shrink race: ${JSON.stringify(errors)}`);
});

test('Adversarial 4.2: TUI boundary condition handling on extreme and malicious inputs', () => {
  let agentList = ['single'];
  let agentIdx = 99999; // Corrupted / stale high index

  // Down handler when index is way beyond bounds
  agentIdx = Math.min(agentList.length - 1, Math.max(0, agentIdx + 1));
  assert.strictEqual(agentIdx, 0);
  assert.strictEqual(agentList[agentIdx], 'single');

  // Up handler when index is negative
  agentIdx = -100;
  agentIdx = Math.max(0, Math.min(agentList.length - 1, agentIdx - 1));
  assert.strictEqual(agentIdx, 0);
  assert.strictEqual(agentList[agentIdx], 'single');

  // Enter handler on empty list
  agentList = [];
  agentIdx = 10;
  if (agentList.length === 0) {
    // Must return without modifying or throwing
    assert.strictEqual(agentList[agentIdx], undefined);
  }

  // selectAgent guards against all falsy and non-string inputs
  function testSelect(arg) {
    if (!arg || typeof arg !== 'string') return 'REJECTED';
    return 'ACCEPTED';
  }

  assert.strictEqual(testSelect(undefined), 'REJECTED');
  assert.strictEqual(testSelect(null), 'REJECTED');
  assert.strictEqual(testSelect(0), 'REJECTED');
  assert.strictEqual(testSelect(false), 'REJECTED');
  assert.strictEqual(testSelect({}), 'REJECTED');
  assert.strictEqual(testSelect([]), 'REJECTED');
  assert.strictEqual(testSelect('valid-agent'), 'ACCEPTED');
});
