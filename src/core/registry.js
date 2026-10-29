// src/core/registry.js - Agent State Card Discovery & Registration
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MESH_DIR } = require('../config');
const { validateAgentName, resolveSafePath, retryNtfsOperation } = require('./mesh');

const VALID_IDES = [
  'antigravity',
  'cursor',
  'windsurf',
  'vscode',
  'claude',
  'claude_code',
  'opencode',
  'qoder',
  'mcode',
  'terminal',
  'jules',
  'custom',
  'unknown'
];

const VALID_ROLES = [
  'worker',
  'reviewer',
  'auditor',
  'explorer',
  'coordinator',
  'architect',
  'critic',
  'specialist',
  'orchestrator',
  'custom'
];

const VALID_STATUSES = ['IDLE', 'BUSY', 'OFFLINE'];

/**
 * Validates an Agent State Card against the Draft-07 schema in ARCHITECTURE.md Section 9.2
 * @param {object} card 
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAgentCard(card) {
  const errors = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { valid: false, errors: ['Agent state card must be a non-null object'] };
  }

  if (typeof card.name !== 'string' || !card.name.trim()) {
    errors.push('Field "name" must be a non-empty string');
  }

  if (card.ide && !VALID_IDES.includes(card.ide)) {
    errors.push(`Field "ide" ("${card.ide}") must be one of: ${VALID_IDES.join(', ')}`);
  }

  if (card.role && !VALID_ROLES.includes(card.role)) {
    errors.push(`Field "role" ("${card.role}") must be one of: ${VALID_ROLES.join(', ')}`);
  }

  if (card.status && !VALID_STATUSES.includes(card.status)) {
    errors.push(`Field "status" ("${card.status}") must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  if (card.pid !== undefined && !Number.isInteger(card.pid)) {
    errors.push('Field "pid" must be an integer');
  }

  if (card.capabilities !== undefined && !Array.isArray(card.capabilities)) {
    errors.push('Field "capabilities" must be an array of strings');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Returns registry file path for an agent
 * @param {string} agentName 
 * @returns {string}
 */
function getRegistryFilePath(agentName) {
  const clean = validateAgentName(agentName);
  const regDir = path.join(MESH_DIR, 'registry');
  if (!fs.existsSync(regDir)) {
    fs.mkdirSync(regDir, { recursive: true });
  }
  return resolveSafePath(regDir, `${clean}.json`);
}

/**
 * Registers an agent in the registry
 * @param {object} agentData 
 * @returns {Promise<object>}
 */
async function registerAgent(agentData = {}) {
  const cleanName = validateAgentName(agentData.name || agentData.agentName);
  const filePath = getRegistryFilePath(cleanName);

  const card = {
    agentId: agentData.agentId || crypto.randomUUID(),
    name: cleanName,
    ide: agentData.ide || 'custom',
    role: agentData.role || 'worker',
    pid: Number.isInteger(agentData.pid) ? agentData.pid : process.pid,
    status: agentData.status || 'IDLE',
    capabilities: Array.isArray(agentData.capabilities) ? agentData.capabilities : [],
    transport: agentData.transport || {
      daemonUrl: 'http://127.0.0.1:4150',
      pipeName: `\\\\.\\pipe\\intercom-${cleanName}`,
      inboxDir: path.join(MESH_DIR, 'inbox', cleanName)
    },
    lastHeartbeat: new Date().toISOString(),
    reuseCount: Number.isInteger(agentData.reuseCount) ? agentData.reuseCount : 0,
    metadata: agentData.metadata || {}
  };

  const validation = validateAgentCard(card);
  if (!validation.valid) {
    throw new Error(`Invalid AgentStateCard: ${validation.errors.join('; ')}`);
  }

  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  await retryNtfsOperation(async () => {
    await fs.promises.writeFile(tmpPath, JSON.stringify(card, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  });

  return card;
}

/**
 * Unregisters an agent (removes registry card or marks OFFLINE)
 * @param {string} agentName 
 * @param {boolean} purge 
 * @returns {Promise<boolean>}
 */
async function unregisterAgent(agentName, purge = false) {
  const cleanName = validateAgentName(agentName);
  const filePath = getRegistryFilePath(cleanName);

  if (!fs.existsSync(filePath)) return false;

  if (purge) {
    await retryNtfsOperation(async () => {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    });
    return true;
  }

  // Soft unregister: mark OFFLINE
  const state = await getAgentState(cleanName);
  if (state) {
    state.status = 'OFFLINE';
    state.lastHeartbeat = new Date().toISOString();
    await retryNtfsOperation(async () => {
      await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    });
  }
  return true;
}

/**
 * Retrieves agent state card from registry
 * @param {string} agentName 
 * @returns {Promise<object|null>}
 */
async function getAgentState(agentName) {
  const cleanName = validateAgentName(agentName);
  const filePath = getRegistryFilePath(cleanName);

  if (!fs.existsSync(filePath)) return null;

  try {
    const content = await retryNtfsOperation(async () => {
      return await fs.promises.readFile(filePath, 'utf8');
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Lists all active agents in registry
 * @param {object} options { staleThresholdMs: 120000, checkPid: true }
 * @returns {Promise<object[]>}
 */
async function listActiveAgents(options = {}) {
  const regDir = path.join(MESH_DIR, 'registry');
  if (!fs.existsSync(regDir)) return [];

  const staleThresholdMs = options.staleThresholdMs || 120000;
  const checkPid = options.checkPid !== false;
  const files = await fs.promises.readdir(regDir);
  const agents = [];

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fullPath = path.join(regDir, f);
    try {
      const content = await fs.promises.readFile(fullPath, 'utf8');
      const card = JSON.parse(content);

      if (card.status === 'OFFLINE') continue;

      const hbTime = Date.parse(card.lastHeartbeat) || 0;
      const isStale = Date.now() - hbTime > staleThresholdMs;

      let isAlive = true;
      if (checkPid && card.pid) {
        try {
          process.kill(card.pid, 0);
        } catch (e) {
          if (e.code === 'ESRCH') {
            isAlive = false;
          }
        }
      }

      if (!isStale && isAlive) {
        agents.push(card);
      } else if (options.includeStale) {
        agents.push({ ...card, isStale: true, isAlive });
      }
    } catch {
      continue;
    }
  }

  return agents;
}

/**
 * Updates agent heartbeat timestamp
 * @param {string} agentName 
 * @returns {Promise<object>}
 */
async function touchHeartbeat(agentName) {
  const cleanName = validateAgentName(agentName);
  let card = await getAgentState(cleanName);
  if (!card) {
    card = await registerAgent({ name: cleanName });
  } else {
    card.lastHeartbeat = new Date().toISOString();
    const filePath = getRegistryFilePath(cleanName);
    await retryNtfsOperation(async () => {
      await fs.promises.writeFile(filePath, JSON.stringify(card, null, 2), 'utf8');
    });
  }
  return card;
}

module.exports = {
  registerAgent,
  unregisterAgent,
  getAgentState,
  listActiveAgents,
  touchHeartbeat,
  validateAgentCard,
  VALID_IDES,
  VALID_ROLES,
  VALID_STATUSES
};
