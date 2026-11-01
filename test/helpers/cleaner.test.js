/**
 * test/helpers/cleaner.test.js
 *
 * Improvement #95: Automated Test Teardown Cleaner Suite.
 * Validates that standardized test teardown cleaners reliably prune
 * ephemeral mailboxes, message JSON files, NTFS CAS locks, and heartbeats.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  cleanAgentMailbox,
  cleanEphemeralMailboxes,
  cleanStaleLocks,
  cleanTestHeartbeats,
  cleanAllTestArtifacts,
  teardownAll
} = require('./cleaner');

describe('Milestone 4 — #95: Automated Standardized Test Teardown Cleaners', () => {
  let tempMeshDir;

  beforeEach(() => {
    tempMeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-test-mesh-'));
    fs.mkdirSync(path.join(tempMeshDir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(tempMeshDir, 'locks'), { recursive: true });
    fs.mkdirSync(path.join(tempMeshDir, 'heartbeats'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempMeshDir, { recursive: true, force: true });
    } catch {}
  });

  test('cleanAgentMailbox removes all message files and empty mailbox directory', () => {
    const agent = 'test-worker-alpha';
    const inboxDir = path.join(tempMeshDir, 'inbox', agent);
    fs.mkdirSync(inboxDir, { recursive: true });

    // Populate mock message files
    fs.writeFileSync(path.join(inboxDir, 'msg-1.json'), JSON.stringify({ id: 1 }));
    fs.writeFileSync(path.join(inboxDir, 'msg-2.json'), JSON.stringify({ id: 2 }));
    fs.writeFileSync(path.join(inboxDir, 'msg-3.json'), JSON.stringify({ id: 3 }));

    assert.equal(fs.readdirSync(inboxDir).length, 3);

    const pruned = cleanAgentMailbox(agent, tempMeshDir);
    assert.equal(pruned, 3, 'Must prune exactly 3 message files');
    assert.equal(fs.existsSync(inboxDir), false, 'Empty mailbox directory must be deleted');
  });

  test('cleanEphemeralMailboxes removes only mailboxes matching test pattern', () => {
    const test1 = path.join(tempMeshDir, 'inbox', 'test-agent-1');
    const test2 = path.join(tempMeshDir, 'inbox', 'ephem-agent-2');
    const prod = path.join(tempMeshDir, 'inbox', 'production-orchestrator');

    fs.mkdirSync(test1, { recursive: true });
    fs.mkdirSync(test2, { recursive: true });
    fs.mkdirSync(prod, { recursive: true });

    const pruned = cleanEphemeralMailboxes(/^(test|ephem)-/i, tempMeshDir);
    assert.equal(pruned, 2, 'Must prune exactly 2 test mailboxes');
    assert.equal(fs.existsSync(test1), false);
    assert.equal(fs.existsSync(test2), false);
    assert.equal(fs.existsSync(prod), true, 'Production mailbox must be preserved');
  });

  test('cleanStaleLocks prunes lock directories exceeding maxAge threshold', () => {
    const freshLock = path.join(tempMeshDir, 'locks', 'fresh.lock');
    const staleLock = path.join(tempMeshDir, 'locks', 'stale.lock');

    fs.mkdirSync(freshLock, { recursive: true });
    fs.mkdirSync(staleLock, { recursive: true });

    // Artificially age the stale lock
    const pastTime = (Date.now() - 10000) / 1000;
    fs.utimesSync(staleLock, pastTime, pastTime);

    const pruned = cleanStaleLocks(5000, tempMeshDir);
    assert.equal(pruned, 1, 'Must prune only stale lock');
    assert.equal(fs.existsSync(staleLock), false);
    assert.equal(fs.existsSync(freshLock), true, 'Fresh lock must be preserved');
  });

  test('cleanTestHeartbeats prunes test heartbeat JSON files', () => {
    const hb1 = path.join(tempMeshDir, 'heartbeats', 'test-worker.json');
    const hb2 = path.join(tempMeshDir, 'heartbeats', 'prod-service.json');

    fs.writeFileSync(hb1, JSON.stringify({ alive: true }));
    fs.writeFileSync(hb2, JSON.stringify({ alive: true }));

    const pruned = cleanTestHeartbeats(/^test-/i, tempMeshDir);
    assert.equal(pruned, 1, 'Must remove only matching heartbeat');
    assert.equal(fs.existsSync(hb1), false);
    assert.equal(fs.existsSync(hb2), true, 'Production heartbeat must be preserved');
  });

  test('teardownAll coordinates complete cleanup of mailboxes, locks, and heartbeats', () => {
    const inbox = path.join(tempMeshDir, 'inbox', 'temp-agent');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'm.json'), '{}');

    const lock = path.join(tempMeshDir, 'locks', 'old.lock');
    fs.mkdirSync(lock, { recursive: true });
    const past = (Date.now() - 5000) / 1000;
    fs.utimesSync(lock, past, past);

    const hb = path.join(tempMeshDir, 'heartbeats', 'temp-hb.json');
    fs.writeFileSync(hb, '{}');

    teardownAll({
      meshDir: tempMeshDir,
      pattern: /^temp-/i,
      lockMaxAgeMs: 1000
    });

    assert.equal(fs.existsSync(inbox), false);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.existsSync(hb), false);
  });

  test('cleanAllTestArtifacts sweeps test mailboxes, legacy files, and locks while keeping permanent agents', () => {
    // Setup test artifacts
    const testBox = path.join(tempMeshDir, 'inbox', 'worker_beta_123');
    const permBox = path.join(tempMeshDir, 'inbox', 'keshav');
    fs.mkdirSync(testBox, { recursive: true });
    fs.mkdirSync(permBox, { recursive: true });

    const testLegacy = path.join(tempMeshDir, 'test_silence_999.json');
    const permLegacy = path.join(tempMeshDir, 'suran.json');
    fs.writeFileSync(testLegacy, '{}');
    fs.writeFileSync(permLegacy, '{}');

    const prunedCount = cleanAllTestArtifacts(undefined, tempMeshDir);
    assert.ok(prunedCount >= 2, 'Should prune at least test mailbox and test legacy file');
    assert.equal(fs.existsSync(testBox), false, 'Ephemeral test box must be removed');
    assert.equal(fs.existsSync(testLegacy), false, 'Ephemeral legacy file must be removed');
    assert.equal(fs.existsSync(permBox), true, 'Permanent agent mailbox must be preserved');
    assert.equal(fs.existsSync(permLegacy), true, 'Permanent agent file must be preserved');
  });
});

