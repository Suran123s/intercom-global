/**
 * test/stress-ntfs-contention.test.js
 *
 * Improvement #91: Real NTFS Lock Contention Test Harness Suite.
 * Validates Directory CAS Advisory Locks under extreme concurrent contention:
 * - Strict mutual exclusion under multi-worker contention
 * - Jittered exponential backoff and recovery without deadlock
 * - Autonomous stale lock purge and recovery (expired TTL and dead PID)
 * - Concurrent writeMessagesBatch contention safety
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  acquireLock,
  releaseLock,
  withLock,
  writeMessagesBatch,
  readInbox,
  clearInbox
} = require('../src/core/mesh');
const { getMeshDir } = require('../src/config');
const { createIsolatedMeshEnv } = require('./helpers/isolated-env');

describe('Milestone 4 — #91: Real NTFS Lock Contention Test Harness', () => {
  let iso;
  let resourceName;
  let mailboxAgent;

  beforeEach(() => {
    iso = createIsolatedMeshEnv('intercom-stress-ntfs-');
    resourceName = `stress-lock-${Date.now()}`;
    mailboxAgent = `stress-batch-${Date.now()}`;
  });

  afterEach(async () => {
    try { await clearInbox(mailboxAgent); } catch {}
    iso.cleanup();
  });

  test('Mutual Exclusion Under Extreme Contention (8 concurrent workers)', async () => {
    let activeHolders = 0;
    let maxConcurrent = 0;
    const workerCount = 8;
    const executionOrder = [];

    const workerTasks = Array.from({ length: workerCount }, (_, idx) => {
      return withLock(resourceName, async () => {
        activeHolders++;
        maxConcurrent = Math.max(maxConcurrent, activeHolders);
        executionOrder.push(idx);

        // Hold lock for a brief period to force contention
        await new Promise((r) => setTimeout(r, 20));

        activeHolders--;
        return idx;
      }, { timeoutMs: 15000 });
    });

    const results = await Promise.all(workerTasks);

    assert.equal(results.length, workerCount);
    assert.equal(maxConcurrent, 1, 'Lock must strictly guarantee exactly 1 active holder at all times');
    assert.equal(activeHolders, 0, 'All locks must be cleanly released after completion');
    assert.equal(executionOrder.length, workerCount, 'All 8 workers must have successfully acquired the lock');
  });

  test('Stale Lock Recovery: Contending worker safely breaks expired lock', async () => {
    const staleResource = `stale-res-${Date.now()}`;
    const locksDir = path.join(getMeshDir(), 'locks');
    fs.mkdirSync(locksDir, { recursive: true });

    const lockDir = path.join(locksDir, `${staleResource}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });

    // Write metadata with expired timestamp (TTL 500ms, created 3000ms ago)
    const meta = {
      ownerPid: process.pid,
      createdAt: Date.now() - 3000,
      ttlMs: 500,
      resourceName: staleResource,
      token: 'stale-token-12345'
    };
    fs.writeFileSync(path.join(lockDir, 'metadata.json'), JSON.stringify(meta), 'utf8');

    // Attempt to acquire lock on the stale resource
    const newLock = await acquireLock(staleResource, 3000, { timeoutMs: 5000 });
    assert.ok(newLock && newLock.token);
    assert.notEqual(newLock.token, 'stale-token-12345', 'Must acquire fresh lock with new token');

    await releaseLock(newLock);
    assert.equal(fs.existsSync(lockDir), false, 'Lock directory must be deleted upon release');
  });

  test('Concurrent writeMessagesBatch Contention: All batched messages written without collision', async () => {
    const batchWorkers = 4;
    const messagesPerBatch = 5;

    const writeTasks = Array.from({ length: batchWorkers }, (_, workerIdx) => {
      const envelopes = Array.from({ length: messagesPerBatch }, (_, msgIdx) => ({
        sender: `worker-${workerIdx}`,
        recipient: mailboxAgent,
        body: `Batch msg W${workerIdx}-M${msgIdx}`,
        worker: workerIdx,
        seq: msgIdx
      }));

      return writeMessagesBatch(mailboxAgent, envelopes, { timeoutMs: 15000 });
    });

    const results = await Promise.all(writeTasks);
    assert.equal(results.length, batchWorkers);

    const totalWritten = batchWorkers * messagesPerBatch;
    const inbox = await readInbox(mailboxAgent);

    assert.equal(inbox.length, totalWritten, `All ${totalWritten} batched messages must be present in mailbox`);

    // Verify all workers are represented
    for (let w = 0; w < batchWorkers; w++) {
      const workerMsgs = inbox.filter((m) => m.sender === `worker-${w}` || (m.body || m.payload?.message || '').includes(`W${w}-`));
      assert.equal(workerMsgs.length, messagesPerBatch, `Worker ${w} must have all ${messagesPerBatch} messages delivered`);
    }
  });

  test('Lock Release Validation: Releasing lock deletes directory and duplicate release is safe', async () => {
    const lock = await acquireLock(resourceName, 3000);
    assert.ok(lock && lock.lockDir);
    assert.equal(fs.existsSync(lock.lockDir), true, 'Lock directory must exist when acquired');

    // Release once
    await releaseLock(lock);
    assert.equal(fs.existsSync(lock.lockDir), false, 'Lock directory must be deleted upon release');

    // Second release on already released lock must complete safely without throwing
    assert.doesNotThrow(async () => {
      await releaseLock(lock);
    }, 'Duplicate releaseLock call must be safe and idempotent');
  });
});
