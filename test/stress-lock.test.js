// test/stress-lock.test.js - CAS Advisory Directory Locking & Stale Lock Recovery Stress Harness
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { acquireLock, releaseLock, LockTimeoutError } = require('../src/core/mesh');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('CAS Locking: Mutual exclusion prevents concurrent access to same resource', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-stress-lock-1-');
  const resource = 'mutex_test_res_' + Date.now();

  const handle1 = await acquireLock(resource, 5000);
  assert.ok(handle1.lockDir);
  assert.ok(fs.existsSync(handle1.lockDir));

  // Second acquisition attempt with short timeout must fail with LockTimeoutError
  let timedOut = false;
  try {
    await acquireLock(resource, 5000, { timeoutMs: 300 });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      timedOut = true;
    }
  }
  assert.strictEqual(timedOut, true, 'Mutual exclusion failed: second acquireLock succeeded while first was active');

  // Release first lock
  await releaseLock(handle1);
  assert.ok(!fs.existsSync(handle1.lockDir), 'Lock directory not removed on release');

  // Now second acquisition succeeds immediately
  const handle2 = await acquireLock(resource, 5000, { timeoutMs: 1000 });
  assert.ok(handle2.lockDir);
  await releaseLock(handle2);
  console.log('[CAS LOCK STRESS] Mutual exclusion and sequential handover verified.');
});

test('CAS Locking: Stale lock recovery within TTL (simulated crashed holder)', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-stress-lock-2-');
  const resource = 'stale_test_res_' + Date.now();
  const TTL_MS = 600;

  // 1. Acquire lock and simulate crash by abandoning it (do NOT release)
  const abandonedHandle = await acquireLock(resource, TTL_MS);
  assert.ok(fs.existsSync(abandonedHandle.lockDir));
  console.log(`[CAS LOCK STRESS] Lock abandoned by owner PID ${abandonedHandle.ownerPid} (TTL: ${TTL_MS}ms)`);

  // Verify contending process is blocked before TTL expires
  const preTtlBlocked = await acquireLock(resource, TTL_MS, { timeoutMs: 200 })
    .then(() => false)
    .catch(err => err instanceof LockTimeoutError);
  assert.strictEqual(preTtlBlocked, true, 'Lock was acquired before TTL expired');

  // Wait for TTL to expire
  const waitMs = TTL_MS + 200;
  console.log(`[CAS LOCK STRESS] Waiting ${waitMs}ms for TTL to expire...`);
  await new Promise(r => setTimeout(r, waitMs));

  // Contending process must recover the stale lock and acquire successfully
  const recoveryStart = Date.now();
  const recoveredHandle = await acquireLock(resource, 3000, { timeoutMs: 2000 });
  const recoveryDuration = Date.now() - recoveryStart;

  assert.ok(recoveredHandle.lockDir, 'Failed to acquire recovered lock');
  assert.notStrictEqual(recoveredHandle.token, abandonedHandle.token, 'Token was not rotated');
  console.log(`[CAS LOCK STRESS] Stale lock successfully recovered in ${recoveryDuration}ms. New token: ${recoveredHandle.token}`);

  await releaseLock(recoveredHandle);
  assert.ok(!fs.existsSync(recoveredHandle.lockDir), 'Lock directory remaining after recovery release');
});

test('CAS Locking: Multi-worker atomic stale recovery under simultaneous contention', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-stress-lock-3-');
  const resource = 'stale_multi_contention_' + Date.now();
  const TTL_MS = 500;

  // 1. Abandon lock
  const abandoned = await acquireLock(resource, TTL_MS);
  assert.ok(fs.existsSync(abandoned.lockDir));

  // Wait for TTL to expire
  await new Promise(r => setTimeout(r, TTL_MS + 150));

  // 2. 5 simultaneous workers attempt to recover the stale lock at the exact same instant
  let successfulAcquisitions = 0;
  let activeHolders = 0;
  let maxConcurrent = 0;

  const attemptRecovery = async (workerId) => {
    try {
      const handle = await acquireLock(resource, 2000, { timeoutMs: 3000 });
      activeHolders++;
      if (activeHolders > maxConcurrent) maxConcurrent = activeHolders;
      successfulAcquisitions++;

      // Simulate holding lock
      await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 20)));

      activeHolders--;
      await releaseLock(handle);
      return { workerId, success: true };
    } catch (err) {
      return { workerId, success: false, error: err.message };
    }
  };

  const contenders = [
    attemptRecovery(1),
    attemptRecovery(2),
    attemptRecovery(3),
    attemptRecovery(4),
    attemptRecovery(5)
  ];

  const results = await Promise.all(contenders);
  assert.strictEqual(maxConcurrent, 1, `Race condition: max concurrent holders during stale recovery was ${maxConcurrent}`);
  assert.strictEqual(activeHolders, 0, 'Locks not cleanly released');
  assert.ok(successfulAcquisitions >= 1, 'No worker succeeded in acquiring the lock');
  console.log(`[CAS LOCK STRESS] Multi-contender stale recovery passed: ${successfulAcquisitions}/5 contenders acquired sequentially without overlap.`);
});

test('CAS Locking: Multi-worker contention under rapid lock/unlock cycles', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-stress-lock-4-');
  const resource = 'contention_res_' + Date.now();
  const NUM_CONTENDERS = 6;
  const CYCLES_PER_CONTENDER = 4;
  let criticalSectionCount = 0;
  let maxConcurrency = 0;

  const runWorker = async (id) => {
    for (let c = 0; c < CYCLES_PER_CONTENDER; c++) {
      const handle = await acquireLock(resource, 2000, { timeoutMs: 5000 });
      criticalSectionCount++;
      if (criticalSectionCount > maxConcurrency) maxConcurrency = criticalSectionCount;

      // Simulated critical section work
      await new Promise(r => setTimeout(r, 10 + Math.floor(Math.random() * 15)));

      criticalSectionCount--;
      await releaseLock(handle);
    }
  };

  const contenders = [];
  for (let i = 0; i < NUM_CONTENDERS; i++) {
    contenders.push(runWorker(i));
  }

  await Promise.all(contenders);
  assert.strictEqual(maxConcurrency, 1, `Race condition detected: max concurrent lock holders was ${maxConcurrency}`);
  assert.strictEqual(criticalSectionCount, 0, 'Critical section count did not reset to 0');
  console.log(`[CAS LOCK STRESS] Multi-contender stress passed: ${NUM_CONTENDERS * CYCLES_PER_CONTENDER} critical sections executed with maxConcurrency=1.`);
});
