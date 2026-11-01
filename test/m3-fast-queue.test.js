/**
 * test/m3-fast-queue.test.js
 *
 * Milestone 3 Suite 5: Fast-Path In-Memory Queue & Subscription Filtering.
 * Validates Improvements:
 * - #67: Fast-path in-memory queue for same-process workers (<1ms latency) with mesh fallback
 * - #68: Event stream subscription filters (type, channel, sender pattern, correlationId)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeMessage, readInbox, clearInbox } = require('../src/core/mesh');
const { FastQueue, SubscriptionFilter } = require('../src/core/fast-queue');

describe('Milestone 3 Suite 5: Fast-Path Queue & Subscription Filtering (#67, #68)', () => {
  let fastQueue;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-queue-m3-test-'));
    process.env.INTERCOM_MESH_DIR = tempDir;
    fastQueue = new FastQueue({ maxQueueDepth: 100 });
  });

  afterEach(() => {
    delete process.env.INTERCOM_MESH_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // #67: Fast-Path In-Memory Dispatch
  test('#67: Delivers in-memory message to same-process local worker without disk I/O in <1ms', async () => {
    const localWorker = 'worker_inproc_01';
    fastQueue.registerLocalAgent(localWorker);

    let receivedMsg = null;
    const startTime = process.hrtime.bigint();

    fastQueue.subscribe(localWorker, null, (msg) => {
      receivedMsg = msg;
    });

    const result = await fastQueue.dispatch(localWorker, {
      sender: 'coordinator',
      type: 'task_dispatch',
      payload: { instruction: 'Perform fast AST transformation' }
    });

    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;

    assert.equal(result.mode, 'fast-path-memory');
    assert.ok(receivedMsg);
    assert.equal(receivedMsg.payload.instruction, 'Perform fast AST transformation');
    assert.ok(durationMs < 5.0, `In-memory dispatch took ${durationMs.toFixed(2)}ms, must be sub-5ms`);
    assert.equal(fastQueue.stats.inMemoryDelivered, 1);
  });

  // #67: Transparent Fallback to File-Mesh for External Agents
  test('#67: Automatically falls back to discrete file-mesh write when recipient is not registered locally', async () => {
    const externalAgent = 'agent_remote_' + crypto.randomUUID().slice(0, 6);
    assert.equal(fastQueue.isLocal(externalAgent), false);

    const result = await fastQueue.dispatch(externalAgent, {
      sender: 'local_worker',
      type: 'task_dispatch',
      priority: 'HIGH',
      payload: { remoteSync: true }
    });

    assert.equal(result.mode, 'safe-path-file-mesh');
    assert.equal(fastQueue.stats.fallbackDelivered, 1);

    // Verify written to discrete mailbox on disk
    const inbox = await readInbox(externalAgent, { limit: 10 });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].payload.remoteSync, true);
  });

  // #67: Bounded Queue Capacity & Eviction
  test('#67: Enforces maxQueueDepth boundary and evicts oldest items to prevent memory bloat', async () => {
    const boundedAgent = 'bounded_worker';
    const smallQueue = new FastQueue({ maxQueueDepth: 5 });
    smallQueue.registerLocalAgent(boundedAgent);

    // Dispatch 8 messages (exceeding bound of 5)
    for (let i = 0; i < 8; i++) {
      await smallQueue.dispatch(boundedAgent, {
        sender: 'sender',
        type: 'task_dispatch',
        payload: { seq: i }
      });
    }

    const q = smallQueue.agentQueues.get(boundedAgent);
    assert.equal(q.length, 5, 'Queue length clamped at maxQueueDepth = 5');
    assert.equal(q[0].payload.seq, 3, 'Oldest messages (0, 1, 2) evicted');
    assert.equal(q[4].payload.seq, 7, 'Newest message retained');
  });

  // #68: Subscription Filter by Message Type & Priority
  test('#68: Subscription filter filters by message type and minimum priority threshold', async () => {
    const agent = 'filtered_worker';
    fastQueue.registerLocalAgent(agent);

    const received = [];
    fastQueue.subscribe(agent, { type: 'interrupt', minPriority: 'HIGH' }, (msg) => {
      received.push(msg);
    });

    // 1. Should be dropped: type is task_dispatch (not interrupt)
    await fastQueue.dispatch(agent, {
      sender: 'orchestrator',
      type: 'task_dispatch',
      priority: 'HIGH',
      payload: { test: 1 }
    });

    // 2. Should be dropped: type is interrupt, but priority is NORMAL (< HIGH)
    await fastQueue.dispatch(agent, {
      sender: 'orchestrator',
      type: 'interrupt',
      priority: 'NORMAL',
      payload: { test: 2 }
    });

    // 3. Should match: type is interrupt and priority is CRITICAL (>= HIGH)
    await fastQueue.dispatch(agent, {
      sender: 'orchestrator',
      type: 'interrupt',
      priority: 'CRITICAL',
      payload: { test: 3 }
    });

    assert.equal(received.length, 1, 'Exactly one message matched criteria');
    assert.equal(received[0].payload.test, 3);
    assert.equal(fastQueue.stats.filteredOut, 2);
  });

  // #68: Wildcard Sender Pattern & Correlation ID Filtering
  test('#68: Filters messages using wildcard sender patterns (worker_*) and correlation ID', async () => {
    const agent = 'subscriber_agent';
    fastQueue.registerLocalAgent(agent);

    const received = [];
    fastQueue.subscribe(agent, { sender: 'worker_*', correlationId: 'corr_xyz_123' }, (msg) => {
      received.push(msg);
    });

    // 1. Dropped: sender matches pattern, but correlationId doesn't match
    await fastQueue.dispatch(agent, {
      sender: 'worker_01',
      type: 'task_dispatch',
      correlationId: 'other_id',
      payload: { note: 'mismatch' }
    });

    // 2. Dropped: correlationId matches, but sender is manager (not worker_*)
    await fastQueue.dispatch(agent, {
      sender: 'manager_01',
      type: 'task_dispatch',
      correlationId: 'corr_xyz_123',
      payload: { note: 'mismatch_sender' }
    });

    // 3. Matched: worker_05 matches worker_* AND correlationId matches
    await fastQueue.dispatch(agent, {
      sender: 'worker_05',
      type: 'task_dispatch',
      correlationId: 'corr_xyz_123',
      payload: { note: 'matched' }
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].payload.note, 'matched');
  });

  // #68: Regex Metacharacter Escaping in Wildcard Patterns
  test('#68: Wildcard pattern matching safely escapes regex metacharacters and prevents syntax errors', () => {
    const unclosedPattern = 'worker_*(unclosed';
    const msg1 = { sender: 'worker_01(unclosed', type: 'task_dispatch' };
    const msg2 = { sender: 'worker_01', type: 'task_dispatch' };

    assert.doesNotThrow(() => {
      assert.equal(SubscriptionFilter.matches(msg1, { sender: unclosedPattern }), true);
      assert.equal(SubscriptionFilter.matches(msg2, { sender: unclosedPattern }), false);
    });

    const complexPattern = 'agent+[test]*?^$';
    const msg3 = { sender: 'agent+[test]extra?^$', type: 'task_dispatch' };
    const msg4 = { sender: 'agent1[test]extra?^$', type: 'task_dispatch' };

    assert.equal(SubscriptionFilter.matches(msg3, { sender: complexPattern }), true);
    assert.equal(SubscriptionFilter.matches(msg4, { sender: complexPattern }), false);
  });
});
