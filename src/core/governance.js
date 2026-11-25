// src/core/governance.js - Teamwork Execution & Governance Invariants
const fs = require('fs');
const path = require('path');
const { getMeshDir } = require('../config');
const { withLockSync, atomicWriteFileSync } = require('./mesh');

class GovernanceViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GovernanceViolationError';
  }
}

const DEFAULT_REUSE_LIMITS = {
  SMALL_TASK: 10,
  BIG_TASK: 3
};

const MAX_REUSE_HISTORY_ENTRIES = 50;
const ALLOWED_KILL_STATES = new Set(['DEAD', 'ARCHIVED']);

function parsePositiveInt(val, fallback) {
  if (val === undefined || val === null || String(val).trim() === '') return fallback;
  const parsed = parseInt(String(val).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Returns configured bounded reuse limits (honoring INTERCOM_REUSE_LIMIT_SMALL / INTERCOM_REUSE_LIMIT_BIG).
 * @returns {{ SMALL_TASK: number, BIG_TASK: number }}
 */
function getReuseLimits() {
  return {
    SMALL_TASK: parsePositiveInt(process.env.INTERCOM_REUSE_LIMIT_SMALL, DEFAULT_REUSE_LIMITS.SMALL_TASK),
    BIG_TASK: parsePositiveInt(process.env.INTERCOM_REUSE_LIMIT_BIG, DEFAULT_REUSE_LIMITS.BIG_TASK)
  };
}

// Bounded reuse limits adhering strictly to ORIGINAL_REQUEST.md line 3025 & ARCHITECTURE.md
const REUSE_LIMITS = {
  get SMALL_TASK() {
    return getReuseLimits().SMALL_TASK;
  },
  get BIG_TASK() {
    return getReuseLimits().BIG_TASK;
  }
};

// In-memory reuse tracking map: agentId -> { turnCount: number, taskType: string, history: Array }
const reuseStore = new Map();

function getTrackerFilePath(ensureDir = false) {
  const regDir = path.join(getMeshDir(), 'registry');
  if (ensureDir && !fs.existsSync(regDir)) {
    try { fs.mkdirSync(regDir, { recursive: true }); } catch {}
  }
  return path.join(regDir, 'reuse-tracker.json');
}

function loadReuseStore(replace = false) {
  const filePath = getTrackerFilePath(false);
  if (replace) {
    reuseStore.clear();
  }
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) {
          reuseStore.set(k, v);
        }
      }
    } catch {}
  }
}

function persistReuseStore() {
  const filePath = getTrackerFilePath(true);
  const obj = {};
  for (const [k, v] of reuseStore.entries()) {
    obj[k] = v;
  }
  atomicWriteFileSync(filePath, JSON.stringify(obj, null, 2));
}

/**
 * Validates an action against the Zero-Kill Protocol Invariant (INVIOLABLE)
 * Strictly forbids killing, terminating, or force-pruning agents unless explicitly DEAD or ARCHIVED.
 * @param {string} action 'kill' | 'terminate' | 'resume' | 'message' ...
 * @param {object} agentState { status: string, name: string }
 * @returns {boolean} true if action is compliant
 * @throws {GovernanceViolationError} if illegal kill attempt
 */
function verifyZeroKill(action, agentState = {}) {
  if (!action || typeof action !== 'string') return true;
  const act = action.toLowerCase().trim();

  if (act === 'kill' || act === 'terminate' || act === 'destroy') {
    const status = String((agentState && agentState.status) || 'RUNNING').trim().toUpperCase();
    if (!ALLOWED_KILL_STATES.has(status)) {
      throw new GovernanceViolationError(
        `Zero-Kill Protocol Invariant Violated: Cannot ${act} agent "${(agentState && agentState.name) || 'target'}" in state ${status}. Mandate: Never terminate active or stopped agents; RESUME or send message instead.`
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
    const status = String((agentState && agentState.status) || 'RUNNING').trim().toUpperCase();
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
  const limits = getReuseLimits();
  const limit = normalizedType === 'BIG' ? limits.BIG_TASK : limits.SMALL_TASK;

  return withLockSync('governance_reuse_tracker', () => {
    loadReuseStore(true);

    const existing = reuseStore.get(agentId);
    const current = existing
      ? {
          turnCount: Number(existing.turnCount) || 0,
          taskType: normalizedType,
          history: Array.isArray(existing.history) ? [...existing.history] : []
        }
      : {
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
    if (current.history.length > MAX_REUSE_HISTORY_ENTRIES) {
      current.history = current.history.slice(-MAX_REUSE_HISTORY_ENTRIES);
    }

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
  });
}

/**
 * Checks whether a worker has reached its bounded reuse limit and should be gracefully rotated
 * @param {string|object} agentIdOrMetadata Agent identifier string or metadata object
 * @returns {boolean} true if worker should be gracefully rotated
 */
function shouldRotateWorker(agentIdOrMetadata) {
  if (!agentIdOrMetadata) return false;
  const limits = getReuseLimits();

  if (typeof agentIdOrMetadata === 'object') {
    const turns = agentIdOrMetadata.turnCount || 0;
    const type = (agentIdOrMetadata.taskType || 'SMALL').toUpperCase().startsWith('B') ? 'BIG' : 'SMALL';
    const limit = type === 'BIG' ? limits.BIG_TASK : limits.SMALL_TASK;
    return turns >= limit;
  }

  loadReuseStore(true);
  const agentId = String(agentIdOrMetadata);
  const data = reuseStore.get(agentId);
  if (!data) return false;

  const limit = data.taskType === 'BIG' ? limits.BIG_TASK : limits.SMALL_TASK;
  return data.turnCount >= limit;
}

/**
 * Retrieves current reuse usage statistics for an agent
 * @param {string} agentId
 * @returns {{ agentId: string, turnCount: number, taskType: string, limit: number, shouldRotate: boolean }}
 */
function getWorkerUsage(agentId) {
  loadReuseStore(true);
  const limits = getReuseLimits();
  const data = reuseStore.get(agentId) || { turnCount: 0, taskType: 'SMALL' };
  const limit = data.taskType === 'BIG' ? limits.BIG_TASK : limits.SMALL_TASK;
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
  if (!agentId) return;
  withLockSync('governance_reuse_tracker', () => {
    loadReuseStore(true);
    reuseStore.delete(agentId);
    persistReuseStore();
  });
}

module.exports = {
  REUSE_LIMITS,
  getReuseLimits,
  GovernanceViolationError,
  verifyZeroKill,
  validateAgentAction,
  resolveSafeAction,
  recordSubagentUse,
  shouldRotateWorker,
  getWorkerUsage,
  resetWorkerUsage
};
