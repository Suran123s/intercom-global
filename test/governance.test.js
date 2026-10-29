// test/governance.test.js - Teamwork Governance Invariants Test Suite
const test = require('node:test');
const assert = require('node:assert');

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

// --- Group 1: Zero-Kill Protocol Invariant (INVIOLABLE) ---
test('governance: Zero-Kill invariant strictly forbids kill/terminate on active or stopped agents', () => {
  const runningAgent = { name: 'worker_alpha', status: 'RUNNING' };
  const stoppedAgent = { name: 'worker_beta', status: 'STOPPED' };
  const pausedAgent = { name: 'worker_gamma', status: 'PAUSED' };
  const idleAgent = { name: 'worker_delta', status: 'IDLE' };

  // Attempting to kill/terminate active or stopped agents must throw GovernanceViolationError
  assert.throws(
    () => verifyZeroKill('kill', runningAgent),
    (err) => {
      assert.ok(err instanceof GovernanceViolationError);
      assert.strictEqual(err.name, 'GovernanceViolationError');
      assert.ok(err.message.includes('Zero-Kill Protocol Invariant Violated'));
      return true;
    }
  );

  assert.throws(
    () => verifyZeroKill('terminate', stoppedAgent),
    GovernanceViolationError
  );

  assert.throws(
    () => verifyZeroKill('destroy', pausedAgent),
    GovernanceViolationError
  );

  assert.throws(
    () => validateAgentAction('kill', idleAgent),
    GovernanceViolationError
  );

  // Non-destructive actions (resume, message, status) pass cleanly
  assert.strictEqual(verifyZeroKill('resume', stoppedAgent), true);
  assert.strictEqual(verifyZeroKill('message', runningAgent), true);
  assert.strictEqual(validateAgentAction('status', runningAgent), true);
});

test('governance: resolveSafeAction converts kill/terminate into resume or message', () => {
  const stopped = { name: 'worker_1', status: 'STOPPED' };
  const paused = { name: 'worker_2', status: 'PAUSED' };
  const running = { name: 'worker_3', status: 'RUNNING' };

  // Stopped/paused converts to 'resume'
  const r1 = resolveSafeAction('kill', stopped);
  assert.strictEqual(r1.safe, true);
  assert.strictEqual(r1.resolvedAction, 'resume');
  assert.ok(r1.reason.includes('Converted illegal termination into RESUME'));

  const r2 = resolveSafeAction('terminate', paused);
  assert.strictEqual(r2.resolvedAction, 'resume');

  // Running converts to 'message'
  const r3 = resolveSafeAction('kill', running);
  assert.strictEqual(r3.resolvedAction, 'message');
  assert.ok(r3.reason.includes('Converted illegal termination into steering MESSAGE'));

  // Compliant action passes through
  const r4 = resolveSafeAction('resume', stopped);
  assert.strictEqual(r4.resolvedAction, 'resume');
});

// --- Group 2: Bounded Subagent Reuse Protocol ---
test('governance: tracks subagent turn counts and enforces bounded reuse (3x big / 10x small)', () => {
  const smallWorkerId = 'worker_test_small_' + Date.now();
  resetWorkerUsage(smallWorkerId);

  // 1. Small task reuse: up to 10 turns
  assert.strictEqual(REUSE_LIMITS.SMALL_TASK, 10);
  assert.strictEqual(REUSE_LIMITS.BIG_TASK, 3);

  for (let i = 1; i <= 9; i++) {
    const res = recordSubagentUse(smallWorkerId, 'SMALL');
    assert.strictEqual(res.turnCount, i);
    assert.strictEqual(res.shouldRotate, false);
    assert.strictEqual(shouldRotateWorker(smallWorkerId), false);
  }

  // 10th turn reaches bound
  const turn10 = recordSubagentUse(smallWorkerId, 'SMALL');
  assert.strictEqual(turn10.turnCount, 10);
  assert.strictEqual(turn10.shouldRotate, true);
  assert.strictEqual(shouldRotateWorker(smallWorkerId), true);

  // Stats retrieval
  const stats = getWorkerUsage(smallWorkerId);
  assert.strictEqual(stats.turnCount, 10);
  assert.strictEqual(stats.limit, 10);
  assert.strictEqual(stats.shouldRotate, true);

  // Reset upon rotation
  resetWorkerUsage(smallWorkerId);
  const resetStats = getWorkerUsage(smallWorkerId);
  assert.strictEqual(resetStats.turnCount, 0);
  assert.strictEqual(resetStats.shouldRotate, false);

  // 2. Big task reuse: up to 3 turns
  const bigWorkerId = 'worker_test_big_' + Date.now();
  resetWorkerUsage(bigWorkerId);

  const b1 = recordSubagentUse(bigWorkerId, 'BIG');
  assert.strictEqual(b1.turnCount, 1);
  assert.strictEqual(b1.shouldRotate, false);

  const b2 = recordSubagentUse(bigWorkerId, 'BIG');
  assert.strictEqual(b2.turnCount, 2);
  assert.strictEqual(b2.shouldRotate, false);

  const b3 = recordSubagentUse(bigWorkerId, 'BIG');
  assert.strictEqual(b3.turnCount, 3);
  assert.strictEqual(b3.shouldRotate, true);
  assert.strictEqual(shouldRotateWorker(bigWorkerId), true);

  resetWorkerUsage(bigWorkerId);
});
