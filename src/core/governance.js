// src/core/governance.js - Teamwork Execution & Governance Invariants
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../config');

class GovernanceViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GovernanceViolationError';
  }
}

// Bounded reuse limits adhering strictly to ORIGINAL_REQUEST.md line 3025 & ARCHITECTURE.md
const REUSE_LIMITS = {
  SMALL_TASK: 10,
  BIG_TASK: 3
};

// In-memory reuse tracking map: agentId -> { turnCount: number, taskType: string, history: Array }
const reuseStore = new Map();

function getTrackerFilePath() {
  const regDir = path.join(MESH_DIR, 'registry');
  if (!fs.existsSync(regDir)) {
    try { fs.mkdirSync(regDir, { recursive: true }); } catch {}
  }
  return path.join(regDir, 'reuse-tracker.json');
}

function loadReuseStore() {
  const filePath = getTrackerFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof data === 'object' && data !== null) {
        for (const [k, v] of Object.entries(data)) {
          reuseStore.set(k, v);
        }
      }
    } catch {}
  }
}

function persistReuseStore() {
  const filePath = getTrackerFilePath();
  const obj = {};
  for (const [k, v] of reuseStore.entries()) {
    obj[k] = v;
  }
  const tmp = `${filePath}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8'); } catch {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

loadReuseStore();

/**
 * Validates an action against the Zero-Kill Protocol Invariant (INVIOLABLE)
 * Strictly forbids killing, terminating, or force-pruning active or stopped subagents
 * @param {string} action 'kill' | 'terminate' | 'resume' | 'message' ...
 * @param {object} agentState { status: 'RUNNING'|'STOPPED'|'PAUSED'|'IDLE', name: string }
 * @returns {boolean} true if action is compliant
 * @throws {GovernanceViolationError} if illegal kill attempt
 */
function verifyZeroKill(action, agentState = {}) {
  if (!action || typeof action !== 'string') return true;
  const act = action.toLowerCase().trim();

  if (act === 'kill' || act === 'terminate' || act === 'destroy') {
    const status = (agentState.status || 'RUNNING').toUpperCase();
    if (status === 'RUNNING' || status === 'STOPPED' || status === 'PAUSED' || status === 'IDLE') {
      throw new GovernanceViolationError(
        `Zero-Kill Protocol Invariant Violated: Cannot ${act} agent "${agentState.name || 'target'}" in state ${status}. Mandate: Never terminate active or stopped agents; RESUME or send message instead.`
      );
    }
  }
  return true;
}

/**
 * Alias for verifyZeroKill adhering to specification contract
 */
function validateAgentAction(action, agentState) {
  return verifyZeroKill(action, agentState);
}

/**
 * Converts a prohibited kill/terminate action safely into resume or instruction message
 * @param {string} action
 * @param {object} agentState
 * @returns {{ originalAction: string, resolvedAction: string, safe: boolean, reason: string }}
 */
function resolveSafeAction(action, agentState = {}) {
  const act = (action || '').toLowerCase().trim();
  if (act === 'kill' || act === 'terminate' || act === 'destroy') {
    const status = (agentState.status || 'RUNNING').toUpperCase();
    if (status === 'STOPPED' || status === 'PAUSED') {
      return {
        originalAction: action,
        resolvedAction: 'resume',
        safe: true,
        reason: 'Converted illegal termination into RESUME command under Zero-Kill Protocol'
      };
    }
    return {
      originalAction: action,
      resolvedAction: 'message',
      safe: true,
      reason: 'Converted illegal termination into steering MESSAGE instruction under Zero-Kill Protocol'
    };
  }

  return {
    originalAction: action,
    resolvedAction: action,
    safe: true,
    reason: 'Action compliant with Zero-Kill Protocol'
  };
}

/**
 * Records a usage cycle for a subagent under the Bounded Subagent Reuse Protocol
 * @param {string} agentId Identifier of worker/subagent
 * @param {'SMALL'|'BIG'} taskType Size classification of completed task (default: SMALL)
 * @returns {{ agentId: string, turnCount: number, taskType: string, limit: number, shouldRotate: boolean }}
 */
function recordSubagentUse(agentId, taskType = 'SMALL') {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agentId string is required to record subagent reuse');
  }

  const normalizedType = taskType && taskType.toUpperCase().startsWith('B') ? 'BIG' : 'SMALL';
  const limit = normalizedType === 'BIG' ? REUSE_LIMITS.BIG_TASK : REUSE_LIMITS.SMALL_TASK;

  const current = reuseStore.get(agentId) || {
    turnCount: 0,
    taskType: normalizedType,
    history: []
  };

  current.turnCount += 1;
  current.taskType = normalizedType;
  current.history.push({
    timestamp: new Date().toISOString(),
    taskType: normalizedType,
    turn: current.turnCount
  });

  reuseStore.set(agentId, current);
  persistReuseStore();

  const shouldRotate = current.turnCount >= limit;

  return {
    agentId,
    turnCount: current.turnCount,
    taskType: normalizedType,
    limit,
    shouldRotate
  };
}

/**
 * Checks whether a worker has reached its bounded reuse limit and should be gracefully rotated
 * @param {string|object} agentIdOrMetadata Agent identifier string or metadata object
 * @returns {boolean} true if worker should be gracefully rotated
 */
function shouldRotateWorker(agentIdOrMetadata) {
  if (!agentIdOrMetadata) return false;

  if (typeof agentIdOrMetadata === 'object') {
    const turns = agentIdOrMetadata.turnCount || 0;
    const type = (agentIdOrMetadata.taskType || 'SMALL').toUpperCase().startsWith('B') ? 'BIG' : 'SMALL';
    const limit = type === 'BIG' ? REUSE_LIMITS.BIG_TASK : REUSE_LIMITS.SMALL_TASK;
    return turns >= limit;
  }

  const agentId = String(agentIdOrMetadata);
  const data = reuseStore.get(agentId);
  if (!data) return false;

  const limit = data.taskType === 'BIG' ? REUSE_LIMITS.BIG_TASK : REUSE_LIMITS.SMALL_TASK;
  return data.turnCount >= limit;
}

/**
 * Retrieves current reuse usage statistics for an agent
 * @param {string} agentId
 * @returns {{ agentId: string, turnCount: number, taskType: string, limit: number, shouldRotate: boolean }}
 */
function getWorkerUsage(agentId) {
  const data = reuseStore.get(agentId) || { turnCount: 0, taskType: 'SMALL' };
  const limit = data.taskType === 'BIG' ? REUSE_LIMITS.BIG_TASK : REUSE_LIMITS.SMALL_TASK;
  return {
    agentId,
    turnCount: data.turnCount,
    taskType: data.taskType,
    limit,
    shouldRotate: data.turnCount >= limit
  };
}

/**
 * Resets an agent's reuse usage statistics after graceful rotation
 * @param {string} agentId
 */
function resetWorkerUsage(agentId) {
  if (agentId) {
    reuseStore.delete(agentId);
    persistReuseStore();
  }
}

module.exports = {
  REUSE_LIMITS,
  GovernanceViolationError,
  verifyZeroKill,
  validateAgentAction,
  resolveSafeAction,
  recordSubagentUse,
  shouldRotateWorker,
  getWorkerUsage,
  resetWorkerUsage
};
