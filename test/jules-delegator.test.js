// test/jules-delegator.test.js - Google Jules Delegation Routing, Limits & Fallback Test Suite
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
const julesBridge = require('../src/bridges/jules-bridge');

// --- Group 1: Single-File Heavy Edit Classifier ---
test('jules-delegator: classifies tasks accurately based on LOC, AST, and scope', () => {
  // Heavy LOC (>100 LOC) on bounded files
  const c1 = classifyTask({
    targetFiles: ['src/core/mesh.js'],
    locModifications: 150
  });
  assert.strictEqual(c1.route, 'JULES');
  assert.strictEqual(c1.isHeavy, true);
  assert.strictEqual(c1.needsPartitioning, false);

  // AST rewrite task
  const c2 = classifyTask({
    targetFiles: ['src/compiler/parser.js'],
    isAstRewrite: true
  });
  assert.strictEqual(c2.route, 'JULES');
  assert.strictEqual(c2.isHeavy, true);

  // Extensive test suite generation (50+ tests)
  const c3 = classifyTask({
    targetFiles: ['test/mesh-stress.test.js'],
    testCount: 65
  });
  assert.strictEqual(c3.route, 'JULES');
  assert.strictEqual(c3.isHeavy, true);

  // Small contained edit (<25 LOC, 1 file)
  const c4 = classifyTask({
    targetFiles: ['src/config.js'],
    locModifications: 10
  });
  assert.strictEqual(c4.route, 'IN_SITU_ANTIGRAVITY');
  assert.strictEqual(c4.isHeavy, false);

  // Standard task (40 LOC, 2 files)
  const c5 = classifyTask({
    targetFiles: ['src/utils.js', 'src/logger.js'],
    locModifications: 40
  });
  assert.strictEqual(c5.route, 'LOCAL_WORKER');
  assert.strictEqual(c5.isHeavy, false);

  // Multi-file task exceeding 3 files
  const c6 = classifyTask({
    targetFiles: ['file1.js', 'file2.js', 'file3.js', 'file4.js', 'file5.js'],
    locModifications: 200
  });
  assert.strictEqual(c6.route, 'LOCAL_WORKER');
  assert.strictEqual(c6.needsPartitioning, true);
  assert.ok(c6.reason.includes('exceeding Jules 1-3 files boundary'));
});

// --- Group 2: Strict 1-3 Files Boundary Enforcement & Partitioning ---
test('jules-delegator: enforces 1-3 files boundary and partitions multi-file manifests', () => {
  // 1-3 files pass directly
  const valid1 = validateFileBoundary(['file1.js']);
  assert.deepStrictEqual(valid1, [['file1.js']]);

  const valid3 = validateFileBoundary(['file1.js', 'file2.js', 'file3.js']);
  assert.deepStrictEqual(valid3, [['file1.js', 'file2.js', 'file3.js']]);

  // >3 files without autoPartition throws FileBoundaryExceededError
  const fiveFiles = ['f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js'];
  assert.throws(
    () => validateFileBoundary(fiveFiles, false),
    (err) => {
      assert.ok(err instanceof FileBoundaryExceededError);
      assert.strictEqual(err.name, 'FileBoundaryExceededError');
      assert.strictEqual(err.fileCount, 5);
      assert.deepStrictEqual(err.files, fiveFiles);
      return true;
    }
  );

  // >3 files with autoPartition partitions into chunks of 3
  const partitioned = validateFileBoundary(fiveFiles, true);
  assert.strictEqual(partitioned.length, 2);
  assert.deepStrictEqual(partitioned[0], ['f1.js', 'f2.js', 'f3.js']);
  assert.deepStrictEqual(partitioned[1], ['f4.js', 'f5.js']);

  // partitionFiles standalone
  const chunks = partitionFiles(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3);
  assert.strictEqual(chunks.length, 3);
  assert.deepStrictEqual(chunks[0], ['a', 'b', 'c']);
  assert.deepStrictEqual(chunks[1], ['d', 'e', 'f']);
  assert.deepStrictEqual(chunks[2], ['g']);
});

// --- Group 3: 5-Pillar High-Precision Prompt Generator & Validator ---
test('jules-delegator: generates and validates unambiguous 5-pillar Markdown prompt', () => {
  const spec = {
    targetFiles: ['src/core/mesh.js'],
    targetLines: 'Lines 200-350',
    summary: 'Refactor CAS locking retry loops to eliminate NTFS race condition',
    symptomContext: 'Windows EBUSY thrown when two parallel workers acquire lock concurrently',
    acceptanceCriteria: [
      'Dual-sided exponential backoff retry loop with randomized jitter',
      'Mutual exclusion verified across 10 concurrent processes',
      'Zero unhandled LockTimeoutErrors'
    ],
    testCommand: 'node --test test/mesh.test.js',
    lintCommand: 'npm run lint',
    boundaries: [
      'Do not modify message serialization schema in message.js',
      'Do not change public API signature of acquireLock / releaseLock'
    ]
  };

  // Generate pillars
  const prompt = generatePillars(spec);
  assert.ok(prompt.includes('## Pillar 1: Exact Target Files & Scope'));
  assert.ok(prompt.includes('## Pillar 2: Observed Symptom & Reproduction Context'));
  assert.ok(prompt.includes('## Pillar 3: Concrete Acceptance Criteria'));
  assert.ok(prompt.includes('## Pillar 4: Mandatory Verification & Test Commands'));
  assert.ok(prompt.includes('## Pillar 5: Strict Guardrails & Non-Goals'));
  assert.ok(prompt.includes('src/core/mesh.js'));
  assert.ok(prompt.includes('Windows EBUSY thrown'));
  assert.ok(prompt.includes('node --test test/mesh.test.js'));

  // Validate prompt
  assert.strictEqual(validateJulesPrompt(prompt), true);
  assert.strictEqual(validateJulesPrompt(spec), true);

  // Incomplete prompt should throw
  assert.throws(() => validateJulesPrompt({
    targetFiles: ['file.js'],
    symptomContext: 'Error'
    // missing criteria, testCommand, boundaries
  }), /Missing mandatory 5-pillar fixing value/);

  // Missing targetFiles should throw
  assert.throws(() => validateJulesPrompt({
    targetFiles: [],
    symptomContext: 'Error',
    acceptanceCriteria: ['pass'],
    testCommand: 'test',
    boundaries: ['guard']
  }), /File Boundary Exceeded/);
});

// --- Group 4: Quota & Concurrency Gating ---
test('jules-delegator: detects and enforces concurrency (15) and daily (100) session caps', async () => {
  const ledgerPath = path.join(os.homedir(), '.intercom-global', 'jules-ledger.json');
  const backup = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : null;

  try {
    // 1. Available quota under normal conditions
    const ledgerHealthy = {
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 5,
      activeSessions: [{ id: 's_1' }, { id: 's_2' }]
    };
    writeLedger(ledgerHealthy);

    const q1 = await checkQuota();
    assert.strictEqual(q1.available, true);
    assert.strictEqual(q1.quotaExceeded, false);
    assert.strictEqual(q1.activeSessions, 2);
    assert.strictEqual(q1.dailySessions, 5);

    // 2. Active Concurrency Limit Reached (15)
    const active15 = [];
    for (let i = 0; i < 15; i++) active15.push({ id: `s_${i}` });
    writeLedger({
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 15,
      activeSessions: active15
    });

    const q2 = await checkQuota();
    assert.strictEqual(q2.available, false);
    assert.strictEqual(q2.quotaExceeded, true);
    assert.ok(q2.reason.includes('concurrency cap reached'));

    // 3. Daily Limit Reached (100)
    writeLedger({
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 100,
      activeSessions: []
    });

    const q3 = await checkQuota();
    assert.strictEqual(q3.available, false);
    assert.strictEqual(q3.quotaExceeded, true);
    assert.ok(q3.reason.includes('daily session cap reached'));
  } finally {
    if (backup) {
      fs.writeFileSync(ledgerPath, backup, 'utf8');
    } else {
      try { fs.unlinkSync(ledgerPath); } catch {}
    }
  }
});

// --- Group 5: Automatic Fallback Routing ---
test('jules-delegator: triggers automatic fallback with disallowJulesReDelegation protection', () => {
  const task = {
    targetFiles: ['src/core/mesh.js', 'src/core/daemon.js'],
    locModifications: 200,
    summary: 'Refactor network transport'
  };

  const fallback = handleFallback(task, 'Concurrency quota reached (15/15 active sessions)');
  assert.strictEqual(fallback.fallbackActivated, true);
  assert.strictEqual(fallback.type, 'TEAMWORK_WORKER');
  assert.strictEqual(fallback.disallowJulesReDelegation, true);
  assert.strictEqual(fallback.taskSpec.disallowJulesReDelegation, true);
  assert.ok(fallback.reason.includes('Concurrency quota reached'));

  // Small task fallback routes to IN_SITU
  const smallTask = {
    targetFiles: ['src/config.js'],
    locModifications: 15
  };
  const fallbackSmall = handleFallback(smallTask, 'Jules CLI unauthenticated');
  assert.strictEqual(fallbackSmall.type, 'IN_SITU');
  assert.strictEqual(fallbackSmall.disallowJulesReDelegation, true);
});

// --- Group 6: Full Dispatch Orchestration (Dry-Run) ---
test('jules-delegator: end-to-end task dispatch in dry-run mode', async () => {
  const ledgerPath = path.join(os.homedir(), '.intercom-global', 'jules-ledger.json');
  try { fs.unlinkSync(ledgerPath); } catch {}

  const taskSpec = {
    targetFiles: ['src/core/mesh.js'],
    summary: 'Overhaul discrete atomic write-rename protocol',
    symptomContext: 'Contending writers under heavy load',
    acceptanceCriteria: ['Pass all 10 writer concurrency tests'],
    testCommand: 'node --test test/mesh.test.js',
    boundaries: ['Zero data drop guarantee'],
    locModifications: 120
  };

  const dispatchRes = await dispatchTask(taskSpec, { dryRun: true });
  assert.strictEqual(dispatchRes.status, 'DISPATCHED');
  assert.strictEqual(dispatchRes.route, 'JULES');
  assert.ok(dispatchRes.sessionId.startsWith('s_mock_'));
  assert.strictEqual(dispatchRes.pillars, 5);
  assert.deepStrictEqual(dispatchRes.files, ['src/core/mesh.js']);

  try { fs.unlinkSync(ledgerPath); } catch {}
});
