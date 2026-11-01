/**
 * test/m3-peer-heartbeat.test.js
 *
 * Milestone 3 Suite 7: Peer Liveness Heartbeat Registry & Message TTL Pruning.
 * Validates Improvements:
 * - #70: Peer liveness heartbeat registry, active tracking & stale peer eviction
 * - #71: Message TTL and automatic pruning of expired messages from inboxes
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { writeMessage, readInbox, clearInbox, HeartbeatRegistry, pruneExpiredInbox } = require('../src/core/mesh');

describe('Milestone 3 Suite 7: Peer Liveness Heartbeat & Message TTL (#70, #71)', () => {
  let tempDir;
  let registry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-ttl-m3-test-'));
    process.env.INTERCOM_MESH_DIR = tempDir;
    registry = new HeartbeatRegistry(tempDir);
  });

  afterEach(() => {
    delete process.env.INTERCOM_MESH_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // #70: Peer Heartbeat Registration & Discovery
  test('#70: Heartbeat registry records peer telemetry and discovers active live peers', () => {
    registry.touchHeartbeat('worker_alpha', { role: 'worker', status: 'idle', pid: 101 });
    registry.touchHeartbeat('reviewer_beta', { role: 'reviewer', status: 'busy', pid: 102 });

    const statusAlpha = registry.getPeerStatus('worker_alpha', 5000);
    assert.equal(statusAlpha.online, true);
    assert.equal(statusAlpha.role, 'worker');
    assert.equal(statusAlpha.status, 'idle');
    assert.equal(statusAlpha.pid, 101);

    const livePeers = registry.listLivePeers(5000);
    assert.equal(livePeers.length, 2);
    const peerNames = livePeers.map((p) => p.agent);
    assert.ok(peerNames.includes('worker_alpha'));
    assert.ok(peerNames.includes('reviewer_beta'));
  });

  // #70: Stale Peer Detection and Eviction
  test('#70: Marks peers stale when heartbeat TTL elapses and evicts abandoned heartbeat files', () => {
    // Record peer with past timestamp (70 seconds ago)
    const staleAgent = 'abandoned_worker';
    const pastEpoch = Date.now() - 70000;
    const staleRecord = {
      agent: staleAgent,
      epochMs: pastEpoch,
      timestamp: new Date(pastEpoch).toISOString(),
      status: 'online'
    };
    fs.writeFileSync(
      path.join(registry.heartbeatDir, `${staleAgent}.json`),
      JSON.stringify(staleRecord, null, 2),
      'utf8'
    );

    // Active peer
    registry.touchHeartbeat('fresh_agent');

    // With 30s TTL, staleAgent must report stale
    const status = registry.getPeerStatus(staleAgent, 30000);
    assert.equal(status.online, false);
    assert.equal(status.status, 'stale');

    // Live peers list only contains fresh_agent
    const live = registry.listLivePeers(30000);
    assert.equal(live.length, 1);
    assert.equal(live[0].agent, 'fresh_agent');

    // Evict stale peers older than 60s
    const evicted = registry.evictStalePeers(60000);
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0], staleAgent);
    assert.equal(fs.existsSync(path.join(registry.heartbeatDir, `${staleAgent}.json`)), false);
  });

  // #71: Message TTL and Auto-Pruning
  test('#71: Automatically prunes expired messages from inbox and forwards to DLQ', () => {
    const inboxDir = path.join(tempDir, 'inbox', 'ttl_test_agent');
    const dlqDir = path.join(tempDir, 'dlq');
    fs.mkdirSync(inboxDir, { recursive: true });

    const now = Date.now();

    // 1. Valid non-expired message (TTL 60s, created 5s ago)
    const validMsg = {
      id: 'msg_valid_01',
      epochMs: now - 5000,
      ttl: 60000,
      payload: { valid: true }
    };
    fs.writeFileSync(path.join(inboxDir, `${validMsg.epochMs}_msg_valid_01.json`), JSON.stringify(validMsg), 'utf8');

    // 2. Expired message via TTL (TTL 10s, created 25s ago)
    const expiredByTtl = {
      id: 'msg_expired_ttl',
      epochMs: now - 25000,
      ttl: 10000,
      payload: { expired: true }
    };
    fs.writeFileSync(path.join(inboxDir, `${expiredByTtl.epochMs}_msg_expired_ttl.json`), JSON.stringify(expiredByTtl), 'utf8');

    // 3. Expired message via explicit expiresAt timestamp
    const expiredByDate = {
      id: 'msg_expired_date',
      epochMs: now - 30000,
      expiresAt: new Date(now - 10000).toISOString(),
      payload: { dateExpired: true }
    };
    fs.writeFileSync(path.join(inboxDir, `${expiredByDate.epochMs}_msg_expired_date.json`), JSON.stringify(expiredByDate), 'utf8');

    // Execute pruning
    const { active, pruned } = pruneExpiredInbox(inboxDir, dlqDir);

    assert.equal(active.length, 1, 'Exactly 1 active non-expired message remains');
    assert.equal(active[0].id, 'msg_valid_01');

    assert.equal(pruned.length, 2, 'Exactly 2 expired messages pruned');
    const prunedIds = pruned.map((m) => m.id);
    assert.ok(prunedIds.includes('msg_expired_ttl'));
    assert.ok(prunedIds.includes('msg_expired_date'));

    // Verify files on disk
    const remainingFiles = fs.readdirSync(inboxDir);
    assert.equal(remainingFiles.length, 1);

    // Verify forwarded to DLQ with deadLetterReason
    const dlqFiles = fs.readdirSync(dlqDir);
    assert.equal(dlqFiles.length, 2);
  });
});
