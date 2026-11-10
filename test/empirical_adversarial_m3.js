// test/empirical_adversarial_m3.js - Milestone 3 Empirical Adversarial Test Harness
// Comprehensive edge cases, dry-run process spawning, CLI subprocess stability & failure handling
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const julesBridge = require('../src/bridges/jules-bridge');
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

const RESULTS = [];

function recordResult(name, status, durationMs, details, error = null) {
  const result = { name, status, durationMs, details, error: error ? error.message : null };
  RESULTS.push(result);
  const mark = status === 'PASS' ? '✔' : '✖';
  console.log(`[${mark}] ${name} (${durationMs.toFixed(2)}ms) -> ${status}`);
  if (details) console.log(`    Details: ${JSON.stringify(details)}`);
  if (error) console.log(`    Error  : ${error.message}`);
}

/**
 * Suite 1: Jules Bridge Adversarial Stress Tests
 */
async function testJulesBridge() {
  const start = Date.now();
  console.log('\n--- SUITE 1: Jules Bridge Adversarial Stress Tests ---');

  // 1.1 Malformed prompts rejection
  const invalidPrompts = [null, undefined, '', '   ', 12345, {}, []];
  for (const inv of invalidPrompts) {
    await assert.rejects(
      async () => await julesBridge.newSession(inv, { dryRun: true }),
      /Task prompt is required/
    );
  }

  // 1.2 Massive prompt payload (100KB string) in dry-run
  const hugePrompt = 'A'.repeat(100 * 1024);
  const hugeRes = await julesBridge.newSession(hugePrompt, { dryRun: true });
  assert.ok(hugeRes.sessionId);
  assert.strictEqual(hugeRes.status, 'QUEUED');
  assert.strictEqual(hugeRes.prompt.length, 100 * 1024);

  // 1.3 Deterministic dry-run environment check
  const envDry = await julesBridge.checkJulesEnvironment({ dryRun: true });
  assert.strictEqual(envDry.installed, true);
  assert.strictEqual(envDry.authenticated, true);
  assert.strictEqual(envDry.inGitRepo, true);
  assert.ok(envDry.version.includes('mock'));

  // 1.4 Non-dry-run environment check does not throw unhandled exceptions
  const envLive = await julesBridge.checkJulesEnvironment({ dryRun: false });
  assert.strictEqual(typeof envLive.installed, 'boolean');
  assert.strictEqual(typeof envLive.authenticated, 'boolean');
  assert.strictEqual(typeof envLive.inGitRepo, 'boolean');

  // 1.5 Session list output parser resilience
  const corruptOutputs = [
    '',
    null,
    'HEADER LINE ONLY\n====\n---',
    'Some random text without session ids\nAnother line',
    's_123456 EXECUTING repo/project Refactor parser\ns_789012 FAILED repo/project Broken test\ns_345678 COMPLETED repo/project Done task'
  ];
  for (const raw of corruptOutputs) {
    const parsed = julesBridge.parseSessionListOutput(raw);
    assert.ok(Array.isArray(parsed));
  }
  const validParsed = julesBridge.parseSessionListOutput(corruptOutputs[4]);
  assert.strictEqual(validParsed.length, 3);
  assert.strictEqual(validParsed[0].id, 's_123456');
  assert.strictEqual(validParsed[0].status, 'EXECUTING');
  assert.strictEqual(validParsed[1].status, 'FAILED');
  assert.strictEqual(validParsed[2].status, 'COMPLETED');

  // 1.6 Pull and Teleport session argument validation
  await assert.rejects(async () => await julesBridge.pullSession(null, { dryRun: true }), /Session ID required/);
  await assert.rejects(async () => await julesBridge.teleportSession('', { dryRun: true }), /Session ID required/);

  const pullRes = await julesBridge.pullSession('s_test_1', { dryRun: true, apply: true });
  assert.strictEqual(pullRes.sessionId, 's_test_1');
  assert.strictEqual(pullRes.applied, true);

  const teleRes = await julesBridge.teleportSession('s_test_2', { dryRun: true });
  assert.strictEqual(teleRes.sessionId, 's_test_2');
  assert.strictEqual(teleRes.teleported, true);

  recordResult('Jules Bridge Adversarial Tests', 'PASS', Date.now() - start, {
    malformedPromptsTested: invalidPrompts.length,
    hugePayloadBytes: hugePrompt.length,
    parserRobustness: 'Verified'
  });
}

/**
 * Suite 2: Jules Delegator Classifier Boundary Stress Tests
 */
async function testClassifierBoundaries() {
  const start = Date.now();
  console.log('\n--- SUITE 2: Classifier Boundary Precision Tests ---');

  // Boundary 1: LOC threshold (100)
  const loc99 = classifyTask({ targetFiles: ['file.js'], locModifications: 99 });
  assert.strictEqual(loc99.route, 'LOCAL_WORKER');
  assert.strictEqual(loc99.isHeavy, false);

  const loc100 = classifyTask({ targetFiles: ['file.js'], locModifications: 100 });
  assert.strictEqual(loc100.route, 'JULES');
  assert.strictEqual(loc100.isHeavy, true);

  const loc101 = classifyTask({ targetFiles: ['file.js'], locModifications: 101 });
  assert.strictEqual(loc101.route, 'JULES');
  assert.strictEqual(loc101.isHeavy, true);

  // Boundary 2: Test suite count threshold (50)
  const test49 = classifyTask({ targetFiles: ['test.js'], testCount: 49 });
  assert.strictEqual(test49.route, 'LOCAL_WORKER');
  assert.strictEqual(test49.isHeavy, false);

  const test50 = classifyTask({ targetFiles: ['test.js'], testCount: 50 });
  assert.strictEqual(test50.route, 'JULES');
  assert.strictEqual(test50.isHeavy, true);

  // Boundary 3: Small contained edit threshold (<25 LOC, 1 file)
  const small24 = classifyTask({ targetFiles: ['file.js'], locModifications: 24 });
  assert.strictEqual(small24.route, 'IN_SITU_ANTIGRAVITY');

  const small25 = classifyTask({ targetFiles: ['file.js'], locModifications: 25 });
  assert.strictEqual(small25.route, 'LOCAL_WORKER');

  // Boundary 4: File count boundaries (1..3 allowed, >3 requires partition)
  const f3 = classifyTask({ targetFiles: ['f1.js', 'f2.js', 'f3.js'], locModifications: 120 });
  assert.strictEqual(f3.route, 'JULES');
  assert.strictEqual(f3.needsPartitioning, false);

  const f4 = classifyTask({ targetFiles: ['f1.js', 'f2.js', 'f3.js', 'f4.js'], locModifications: 120 });
  assert.strictEqual(f4.route, 'LOCAL_WORKER');
  assert.strictEqual(f4.needsPartitioning, true);

  // Boundary 5: Auto-partitioning
  const chunks = partitionFiles(['1.js', '2.js', '3.js', '4.js', '5.js', '6.js', '7.js'], 3);
  assert.strictEqual(chunks.length, 3);
  assert.deepStrictEqual(chunks[0], ['1.js', '2.js', '3.js']);
  assert.deepStrictEqual(chunks[1], ['4.js', '5.js', '6.js']);
  assert.deepStrictEqual(chunks[2], ['7.js']);

  recordResult('Classifier Boundary Tests', 'PASS', Date.now() - start, {
    loc99: loc99.route,
    loc100: loc100.route,
    test49: test49.route,
    test50: test50.route,
    small24: small24.route,
    small25: small25.route,
    f3: f3.route,
    f4_needsPartitioning: f4.needsPartitioning
  });
}

/**
 * Suite 3: 5-Pillar High-Precision Prompt Generator & Validator Stress Tests
 */
async function test5Pillars() {
  const start = Date.now();
  console.log('\n--- SUITE 3: 5-Pillar Generator & Validator Tests ---');

  const completeSpec = {
    targetFiles: ['src/core/mesh.js'],
    targetLines: '200-300',
    summary: 'CAS Advisory Locking Refactor',
    symptomContext: 'Intermittent Windows NTFS EBUSY collisions under high concurrency',
    acceptanceCriteria: ['Pass 10 concurrent writer tests', '0 corrupted mailboxes'],
    testCommand: 'node --test test/m2_core.test.js',
    lintCommand: 'npm run lint',
    boundaries: ['Do not change public function signatures', 'Do not alter MessageEnvelope schema']
  };

  // 3.1 Prompt generation contains all 5 headings and fixing values
  const prompt = generatePillars(completeSpec);
  for (let i = 1; i <= 5; i++) {
    assert.ok(prompt.includes(`## Pillar ${i}:`), `Must contain Pillar ${i} heading`);
  }
  assert.ok(prompt.includes('src/core/mesh.js'));
  assert.ok(prompt.includes('node --test test/m2_core.test.js'));
  assert.ok(prompt.includes('Integrity Directive'));

  // 3.2 Validator passes valid prompt string and valid spec object
  assert.strictEqual(validateJulesPrompt(prompt), true);
  assert.strictEqual(validateJulesPrompt(completeSpec), true);

  // 3.3 Validator rejects missing pillars
  const missingPillars = [
    { ...completeSpec, targetFiles: [] },
    { ...completeSpec, symptomContext: '' },
    { ...completeSpec, acceptanceCriteria: [] },
    { ...completeSpec, testCommand: '' },
    { ...completeSpec, boundaries: [] }
  ];

  for (const m of missingPillars) {
    assert.throws(() => validateJulesPrompt(m), /Missing mandatory 5-pillar fixing value|targetFiles must be a non-empty|File Boundary Exceeded/);
  }

  // 3.4 Raw string with missing heading fails
  const incompleteRaw = `# JULES PROMPT\n## Pillar 1: Scope\n## Pillar 2: Symptom\n## Pillar 3: Criteria`;
  assert.throws(() => validateJulesPrompt(incompleteRaw), /Missing mandatory 5-pillar heading/);

  recordResult('5-Pillar Prompting & Validation Tests', 'PASS', Date.now() - start, {
    headingsVerified: 5,
    missingPillarsCaught: missingPillars.length
  });
}

/**
 * Suite 4: Jules Quota, Concurrency & Fallback Gating
 */
async function testQuotaAndFallback() {
  const start = Date.now();
  console.log('\n--- SUITE 4: Quota Gating & Fallback Tests ---');

  const initialLedger = readLedger();

  try {
    // 4.1 Concurrency cap testing (15 active sessions)
    const saturatedLedger = {
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 5,
      activeSessions: Array.from({ length: 15 }, (_, i) => ({ id: `s_${i}` }))
    };
    writeLedger(saturatedLedger);

    const quotaSaturated = await checkQuota({ dryRun: true });
    assert.strictEqual(quotaSaturated.available, false);
    assert.strictEqual(quotaSaturated.activeSessions, 15);
    assert.ok(quotaSaturated.reason.includes('concurrency cap reached'));

    // 4.2 Daily cap testing (100 daily sessions)
    const dailyCappedLedger = {
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 100,
      activeSessions: []
    };
    writeLedger(dailyCappedLedger);

    const quotaDailyCapped = await checkQuota({ dryRun: true });
    assert.strictEqual(quotaDailyCapped.available, false);
    assert.strictEqual(quotaDailyCapped.dailySessions, 100);
    assert.ok(quotaDailyCapped.reason.includes('daily session cap reached'));

    // 4.3 Fallback routing & disallowJulesReDelegation recursion prevention
    const smallTask = { targetFiles: ['small.js'], locModifications: 20 };
    const fallbackSmall = handleFallback(smallTask, 'Quota exhausted');
    assert.strictEqual(fallbackSmall.fallbackActivated, true);
    assert.strictEqual(fallbackSmall.type, 'IN_SITU');
    assert.strictEqual(fallbackSmall.disallowJulesReDelegation, true);
    assert.strictEqual(fallbackSmall.taskSpec.disallowJulesReDelegation, true);

    const bigTask = { targetFiles: ['big1.js', 'big2.js'], locModifications: 300 };
    const fallbackBig = handleFallback(bigTask, 'Quota exhausted');
    assert.strictEqual(fallbackBig.type, 'TEAMWORK_WORKER');
    assert.strictEqual(fallbackBig.disallowJulesReDelegation, true);

    // If task already has disallowJulesReDelegation, dispatchTask immediately returns fallback
    const recursiveTask = { ...bigTask, disallowJulesReDelegation: true };
    const dispatchRes = await dispatchTask(recursiveTask, { dryRun: true });
    assert.strictEqual(dispatchRes.fallbackActivated, true);
    assert.ok(dispatchRes.reason.includes('disallowJulesReDelegation'));

    recordResult('Quota Gating & Fallback Tests', 'PASS', Date.now() - start, {
      concurrencyCapTested: 15,
      dailyCapTested: 100,
      fallbackSmallType: fallbackSmall.type,
      fallbackBigType: fallbackBig.type,
      infiniteRecursionPrevented: true
    });
  } finally {
    writeLedger(initialLedger);
  }
}

/**
 * Suite 5: Zero-Kill & Governance Invariant Rigor
 */
async function testGovernanceInvariants() {
  const start = Date.now();
  console.log('\n--- SUITE 5: Zero-Kill & Governance Invariants Tests ---');

  const states = ['RUNNING', 'STOPPED', 'PAUSED', 'IDLE'];
  const killActions = ['kill', 'KILL', 'terminate', 'TERMINATE', 'destroy', 'Destroy'];

  // 5.1 Strict rejection of all kill variants
  for (const st of states) {
    for (const act of killActions) {
      assert.throws(
        () => verifyZeroKill(act, { name: 'test_agent', status: st }),
        GovernanceViolationError,
        `Must reject "${act}" for agent in state "${st}"`
      );
    }
  }

  // 5.2 Safe action conversion
  const convStopped = resolveSafeAction('kill', { name: 'agent1', status: 'STOPPED' });
  assert.strictEqual(convStopped.resolvedAction, 'resume');
  assert.strictEqual(convStopped.safe, true);

  const convPaused = resolveSafeAction('terminate', { name: 'agent2', status: 'PAUSED' });
  assert.strictEqual(convPaused.resolvedAction, 'resume');

  const convRunning = resolveSafeAction('destroy', { name: 'agent3', status: 'RUNNING' });
  assert.strictEqual(convRunning.resolvedAction, 'message');

  // 5.3 Bounded subagent reuse and rotation flag verification
  const workerId = 'adv_worker_' + Date.now();
  resetWorkerUsage(workerId);

  // 10 turns for small task
  for (let i = 1; i <= 9; i++) {
    const res = recordSubagentUse(workerId, 'SMALL');
    assert.strictEqual(res.turnCount, i);
    assert.strictEqual(res.shouldRotate, false);
    assert.strictEqual(shouldRotateWorker(workerId), false);
  }

  // 10th turn triggers shouldRotate without terminating process
  const turn10 = recordSubagentUse(workerId, 'SMALL');
  assert.strictEqual(turn10.turnCount, 10);
  assert.strictEqual(turn10.shouldRotate, true);
  assert.strictEqual(shouldRotateWorker(workerId), true);

  // Big task: 3 turns
  const bigWorker = 'adv_big_worker_' + Date.now();
  resetWorkerUsage(bigWorker);
  recordSubagentUse(bigWorker, 'BIG');
  recordSubagentUse(bigWorker, 'BIG');
  const b3 = recordSubagentUse(bigWorker, 'BIG');
  assert.strictEqual(b3.turnCount, 3);
  assert.strictEqual(b3.shouldRotate, true);

  resetWorkerUsage(workerId);
  resetWorkerUsage(bigWorker);

  recordResult('Zero-Kill & Governance Invariants Tests', 'PASS', Date.now() - start, {
    statesChecked: states.length,
    killActionsChecked: killActions.length,
    safeConversionsVerified: 3,
    smallCap: 10,
    bigCap: 3
  });
}

/**
 * Suite 6: CLI Subprocess & Command Stability Tests
 */
async function testCliSubprocess() {
  const start = Date.now();
  console.log('\n--- SUITE 6: CLI Subprocess & Execution Tests ---');

  const cliPath = path.join(__dirname, '../bin/intercom.js');

  // Helper to invoke CLI synchronously
  function execCli(args) {
    try {
      const stdout = execSync(`node "${cliPath}" ${args}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, JULES_DRY_RUN: 'true' }
      });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status || 1, stdout: err.stdout ? err.stdout.toString() : '', stderr: err.stderr ? err.stderr.toString() : '' };
    }
  }

  // 6.1 `intercom jules check`
  const res1 = execCli('jules check');
  assert.strictEqual(res1.code, 0);
  assert.ok(res1.stdout.includes('GOOGLE JULES ENVIRONMENT & QUOTA CHECK'));
  assert.ok(res1.stdout.includes('Active Sessions'));

  // 6.2 `intercom governance check` with agent
  const res2 = execCli('governance check test_agent_cli');
  assert.strictEqual(res2.code, 0);
  assert.ok(res2.stdout.includes('GOVERNANCE USAGE CARD: test_agent_cli'));
  assert.ok(res2.stdout.includes('Turn Count'));

  // 6.3 Missing required argument exits with 1 and clean error message
  const res3 = execCli('governance check');
  assert.strictEqual(res3.code, 1);
  assert.ok(res3.stderr.includes('Agent name required'));

  const res4 = execCli('jules pull');
  assert.strictEqual(res4.code, 1);
  assert.ok(res4.stderr.includes('Session ID required'));

  recordResult('CLI Subprocess Stability Tests', 'PASS', Date.now() - start, {
    julesCheckExitCode: res1.code,
    governanceCheckExitCode: res2.code,
    missingArgExitCodes: [res3.code, res4.code]
  });
}

async function runAll() {
  console.log('================================================================================');
  console.log('    CHALLENGER 2: EMPIRICAL ADVERSARIAL STRESS-TEST HARNESS (MILESTONE 3)       ');
  console.log('================================================================================');

  await testJulesBridge();
  await testClassifierBoundaries();
  await test5Pillars();
  await testQuotaAndFallback();
  await testGovernanceInvariants();
  await testCliSubprocess();

  console.log('\n================================================================================');
  console.log('                            EXECUTION SUMMARY REPORT                            ');
  console.log('================================================================================');
  const passed = RESULTS.filter(r => r.status === 'PASS').length;
  const failed = RESULTS.filter(r => r.status === 'FAIL').length;
  console.log(`TOTAL SUITES: ${RESULTS.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================================');

  return { total: RESULTS.length, passed, failed, results: RESULTS };
}

if (require.main === module) {
  runAll().catch(err => {
    console.error('Fatal test harness execution error:', err);
    process.exit(1);
  });
}

module.exports = { runAll, RESULTS };
