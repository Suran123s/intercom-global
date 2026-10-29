// test/stress-m3-adversarial.test.js - Milestone 3 Adversarial Stress Harness
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const {
  classifyTask,
  partitionFiles,
  validateFileBoundary,
  generatePillars,
  validateJulesPrompt,
  checkQuota,
  handleFallback,
  dispatchTask,
  readLedger,
  writeLedger,
  FileBoundaryExceededError,
  JULES_LIMITS
} = require('../src/core/jules-delegator');

const {
  verifyZeroKill,
  validateAgentAction,
  resolveSafeAction,
  recordSubagentUse,
  shouldRotateWorker,
  getWorkerUsage,
  resetWorkerUsage,
  GovernanceViolationError,
  REUSE_LIMITS
} = require('../src/core/governance');

// --- Experiment 1: Adversarial Boundary Testing ---
test('Adversarial Boundary: strictly enforces 1-3 files boundary across large manifests and edge cases', async () => {
  // Case A: 4 files without autoPartition -> throws FileBoundaryExceededError
  const fourFiles = ['a.js', 'b.js', 'c.js', 'd.js'];
  assert.throws(
    () => validateFileBoundary(fourFiles, false),
    (err) => {
      assert.ok(err instanceof FileBoundaryExceededError);
      assert.strictEqual(err.fileCount, 4);
      return true;
    }
  );

  // Case B: 10 files without autoPartition
  const tenFiles = Array.from({ length: 10 }, (_, i) => `file_${i}.js`);
  assert.throws(
    () => validateFileBoundary(tenFiles, false),
    (err) => {
      assert.ok(err instanceof FileBoundaryExceededError);
      assert.strictEqual(err.fileCount, 10);
      return true;
    }
  );

  // Case C: 50 files without autoPartition
  const fiftyFiles = Array.from({ length: 50 }, (_, i) => `file_${i}.js`);
  assert.throws(
    () => validateFileBoundary(fiftyFiles, false),
    (err) => {
      assert.ok(err instanceof FileBoundaryExceededError);
      assert.strictEqual(err.fileCount, 50);
      return true;
    }
  );

  // Case D: 50 files with autoPartition -> returns exactly 17 chunks, all <= 3
  const partitioned50 = validateFileBoundary(fiftyFiles, true);
  assert.strictEqual(partitioned50.length, Math.ceil(50 / 3)); // 17 chunks
  for (const chunk of partitioned50) {
    assert.ok(chunk.length >= 1 && chunk.length <= 3, `Chunk exceeded boundary: ${chunk.length}`);
  }
  assert.strictEqual(partitioned50.flat().length, 50);

  // Case E: 0 files or empty arrays
  assert.throws(() => validateFileBoundary([], false), /non-empty array/);
  assert.throws(() => validateFileBoundary([], true), /non-empty array/);

  // Case F: Non-array inputs
  assert.throws(() => validateFileBoundary(null), /non-empty array/);
  assert.throws(() => validateFileBoundary(undefined), /non-empty array/);
  assert.throws(() => validateFileBoundary('not-an-array'), /non-empty array/);
  assert.throws(() => validateFileBoundary(12345), /non-empty array/);

  // Case G: dispatchTask with 4 files and autoPartition: false must throw FileBoundaryExceededError
  await assert.rejects(
    async () => {
      await dispatchTask({
        targetFiles: fourFiles,
        locModifications: 200,
        summary: 'Heavy refactor on 4 files'
      }, { forceJules: true, autoPartition: false });
    },
    (err) => err instanceof FileBoundaryExceededError
  );

  console.log('[M3 ADVERSARIAL] Experiment 1: Boundary enforcement passed (4, 10, 50, 0, null, dispatch).');
});

// --- Experiment 2: 5-Pillar Template Completeness & Strict Validation ---
test('Adversarial Prompting: strictly rejects omissions of any of the 5 mandatory fixing-value pillars', () => {
  const completeSpec = {
    targetFiles: ['src/core/mesh.js'],
    targetLines: 'Lines 100-200',
    summary: 'Refactor lock acquisition',
    symptomContext: 'Race condition on concurrent NTFS rename',
    acceptanceCriteria: ['Zero corrupted files', '100% mutual exclusion'],
    testCommand: 'node --test test/mesh.test.js',
    lintCommand: 'npm run lint',
    boundaries: ['Do not change public function signatures']
  };

  // Valid spec passes
  assert.strictEqual(validateJulesPrompt(completeSpec), true);

  // Missing Pillar 1: targetFiles empty
  assert.throws(
    () => validateJulesPrompt({ ...completeSpec, targetFiles: [] }),
    (err) => err instanceof FileBoundaryExceededError
  );

  // Missing Pillar 2: symptomContext missing
  assert.throws(
    () => validateJulesPrompt({ ...completeSpec, symptomContext: undefined }),
    /Missing mandatory 5-pillar fixing value: Pillar 2/
  );

  // Missing Pillar 3: acceptanceCriteria missing or empty
  assert.throws(
    () => validateJulesPrompt({ ...completeSpec, acceptanceCriteria: [] }),
    /Missing mandatory 5-pillar fixing value: Pillar 3/
  );

  // Missing Pillar 4: testCommand missing
  assert.throws(
    () => validateJulesPrompt({ ...completeSpec, testCommand: '' }),
    /Missing mandatory 5-pillar fixing value: Pillar 4/
  );

  // Missing Pillar 5: boundaries missing or empty
  assert.throws(
    () => validateJulesPrompt({ ...completeSpec, boundaries: [] }),
    /Missing mandatory 5-pillar fixing value: Pillar 5/
  );

  // String prompt missing a pillar heading
  const generated = generatePillars(completeSpec);
  assert.strictEqual(validateJulesPrompt(generated), true);

  const corruptedString = generated.replace('## Pillar 4: Mandatory Verification & Test Commands', '## Verification');
  assert.throws(
    () => validateJulesPrompt(corruptedString),
    /Missing mandatory 5-pillar heading "Pillar 4:"/
  );

  console.log('[M3 ADVERSARIAL] Experiment 2: 5-Pillar prompt validation passed (all 5 pillars strictly required).');
});

// --- Experiment 3: Quota Overflow & Concurrent Ceiling ---
test('Adversarial Quota: detects active session overflow (>=15) and daily overflow (>=100) and routes to fallback', async () => {
  const ledgerPath = path.join(os.homedir(), '.intercom-global', 'jules-ledger.json');
  const backup = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : null;

  try {
    // 1. Exactly 15 active sessions -> quota exceeded
    const active15 = Array.from({ length: 15 }, (_, i) => ({ id: `s_${i}` }));
    writeLedger({
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 15,
      activeSessions: active15
    });

    const q1 = await checkQuota();
    assert.strictEqual(q1.available, false);
    assert.strictEqual(q1.quotaExceeded, true);
    assert.strictEqual(q1.activeSessions, 15);
    assert.ok(q1.reason.includes('concurrency cap reached: 15/15'));

    // 2. Overflow to 20 active sessions -> strictly rejected
    const active20 = Array.from({ length: 20 }, (_, i) => ({ id: `s_${i}` }));
    writeLedger({
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 20,
      activeSessions: active20
    });
    const q2 = await checkQuota();
    assert.strictEqual(q2.available, false);
    assert.strictEqual(q2.activeSessions, 20);

    // 3. Exactly 100 daily sessions -> quota exceeded
    writeLedger({
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 100,
      activeSessions: []
    });
    const q3 = await checkQuota();
    assert.strictEqual(q3.available, false);
    assert.strictEqual(q3.quotaExceeded, true);
    assert.strictEqual(q3.dailySessions, 100);
    assert.ok(q3.reason.includes('daily session cap reached: 100/100'));

    // 4. Calling dispatchTask when quota is exceeded automatically activates fallback
    const heavyTask = {
      targetFiles: ['src/core/mesh.js'],
      locModifications: 200,
      summary: 'Heavy refactor under quota saturation',
      symptomContext: 'Saturated',
      acceptanceCriteria: ['pass'],
      testCommand: 'test',
      boundaries: ['guard']
    };
    const dispatchFallback = await dispatchTask(heavyTask, { dryRun: true });
    assert.strictEqual(dispatchFallback.fallbackActivated, true);
    assert.strictEqual(dispatchFallback.type, 'TEAMWORK_WORKER');
    assert.strictEqual(dispatchFallback.disallowJulesReDelegation, true);
    assert.ok(dispatchFallback.reason.includes('daily session cap reached'));

    console.log('[M3 ADVERSARIAL] Experiment 3: Quota overflow handling passed (15 concurrent, 100 daily, fallback triggered).');
  } finally {
    if (backup) {
      fs.writeFileSync(ledgerPath, backup, 'utf8');
    } else {
      try { fs.unlinkSync(ledgerPath); } catch {}
    }
  }
});

// --- Experiment 4: Fallback Circular Loop Prevention ---
test('Adversarial Fallback: disallowJulesReDelegation eliminates recursive fallback loops', async () => {
  const taskSpec = {
    targetFiles: ['src/core/mesh.js'],
    locModifications: 150,
    summary: 'Refactor transport',
    disallowJulesReDelegation: true // Already fallen back once
  };

  // Attempting to dispatch a task that has already fallen back must immediately return fallback
  const result = await dispatchTask(taskSpec, { forceJules: true });
  assert.strictEqual(result.fallbackActivated, true);
  assert.strictEqual(result.disallowJulesReDelegation, true);
  assert.strictEqual(result.taskSpec.disallowJulesReDelegation, true);
  assert.ok(result.reason.includes('disallowJulesReDelegation: true'));

  console.log('[M3 ADVERSARIAL] Experiment 4: Anti-recursion fallback guard verified.');
});

// --- Experiment 5: Zero-Kill Protocol Invariant Stress-Testing ---
test('Adversarial Governance: Zero-Kill invariant strictly rejects kill/terminate across ALL states', () => {
  const states = ['RUNNING', 'PAUSED', 'STOPPED', 'IDLE', 'running', 'paused', 'stopped', 'idle'];
  const hostileActions = ['kill', 'terminate', 'destroy', 'KILL', 'TERMINATE', 'DESTROY', ' kill ', 'terminate '];

  for (const st of states) {
    const agent = { name: `agent_${st}`, status: st };
    for (const act of hostileActions) {
      // Must throw GovernanceViolationError
      assert.throws(
        () => verifyZeroKill(act, agent),
        (err) => {
          assert.ok(err instanceof GovernanceViolationError);
          assert.ok(err.message.includes('Zero-Kill Protocol Invariant Violated'));
          return true;
        },
        `Failed to reject ${act} on state ${st}`
      );

      assert.throws(
        () => validateAgentAction(act, agent),
        GovernanceViolationError
      );

      // Safe resolution conversion
      const safe = resolveSafeAction(act, agent);
      assert.strictEqual(safe.safe, true);
      const upperState = st.toUpperCase();
      if (upperState === 'STOPPED' || upperState === 'PAUSED') {
        assert.strictEqual(safe.resolvedAction, 'resume', `Expected resume for ${st}`);
      } else {
        assert.strictEqual(safe.resolvedAction, 'message', `Expected message for ${st}`);
      }
    }
  }

  // Non-destructive actions are allowed
  const safeActions = ['resume', 'message', 'status', 'heartbeat', 'ping', 'inspect'];
  for (const act of safeActions) {
    assert.strictEqual(verifyZeroKill(act, { name: 'worker', status: 'RUNNING' }), true);
  }

  console.log('[M3 ADVERSARIAL] Experiment 5: Zero-Kill invariant stress passed across all states and hostile actions.');
});

// --- Experiment 6: Bounded Subagent Reuse Counter ---
test('Adversarial Governance: enforces precise turn thresholds (3x big, 10x small)', () => {
  // Big Task Test (Max: 3)
  const bigWorker = 'adv_worker_big_' + Date.now();
  resetWorkerUsage(bigWorker);

  const t1 = recordSubagentUse(bigWorker, 'BIG');
  assert.strictEqual(t1.turnCount, 1);
  assert.strictEqual(t1.shouldRotate, false);

  const t2 = recordSubagentUse(bigWorker, 'BIG');
  assert.strictEqual(t2.turnCount, 2);
  assert.strictEqual(t2.shouldRotate, false);

  const t3 = recordSubagentUse(bigWorker, 'BIG');
  assert.strictEqual(t3.turnCount, 3);
  assert.strictEqual(t3.shouldRotate, true);
  assert.strictEqual(shouldRotateWorker(bigWorker), true);

  // Turn past limit
  const t4 = recordSubagentUse(bigWorker, 'BIG');
  assert.strictEqual(t4.turnCount, 4);
  assert.strictEqual(t4.shouldRotate, true);
  assert.strictEqual(shouldRotateWorker(bigWorker), true);

  resetWorkerUsage(bigWorker);
  assert.strictEqual(shouldRotateWorker(bigWorker), false);

  // Small Task Test (Max: 10)
  const smallWorker = 'adv_worker_small_' + Date.now();
  resetWorkerUsage(smallWorker);

  for (let i = 1; i <= 9; i++) {
    const res = recordSubagentUse(smallWorker, 'SMALL');
    assert.strictEqual(res.turnCount, i);
    assert.strictEqual(res.shouldRotate, false);
    assert.strictEqual(shouldRotateWorker(smallWorker), false);
  }

  const turn10 = recordSubagentUse(smallWorker, 'SMALL');
  assert.strictEqual(turn10.turnCount, 10);
  assert.strictEqual(turn10.shouldRotate, true);
  assert.strictEqual(shouldRotateWorker(smallWorker), true);

  // Turn past limit
  const turn11 = recordSubagentUse(smallWorker, 'SMALL');
  assert.strictEqual(turn11.turnCount, 11);
  assert.strictEqual(turn11.shouldRotate, true);

  resetWorkerUsage(smallWorker);
  console.log('[M3 ADVERSARIAL] Experiment 6: Bounded reuse counter passed (3x big, 10x small).');
});
