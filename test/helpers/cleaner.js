/**
 * test/helpers/cleaner.js
 *
 * Improvement #95: Automated Standardized Test Teardown Cleaner.
 * Provides resilient cleanup hooks for ephemeral mailboxes, discrete message files,
 * NTFS CAS lock directories, heartbeats, and test artifacts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MESH_DIR } = require('../../src/config');

const EPHEMERAL_PREFIX_REGEX = /^(test|worker|stress|a2a|wake|ephem|fuzz|dry-agent|tmp_|agent[-_]|alpha_|architect_|beta_|coordinator_|reviewer_|challenger_|auditor_|batch[-_]|brand[-_]|cli[-_]|ended[-_]|epipe[-_]|live[-_]|task[-_]|sess[-_]|subworker[-_]|slow[-_]|executor[-_]|explorer[-_]?|crash[-_]|unit[-_]|recursion[-_]|burst[-_]|chrono[-_]|adv[-_]|sse[-_]|resilience[-_]|interrupt[-_]|mtime[-_]|locked[-_]|fallback[-_]|orchestrator[-_]|peer[-_]|merge[-_]|fast-path[-_]?|inbox[-_]|operator|boss[-_]|general|mimo[-_]|external_daemon[-_]?|reviewer$|opencode-coordinator$|[ab]$)/i;
const PERMANENT_AGENTS = new Set(['suran', 'aditya', 'akash', 'keshav', 'madhav', 'pal', 'satyam', 'antigravity', 'opencode', 'claude']);

/**
 * Removes all files in a directory recursively without throwing if missing.
 * @param {string} targetDir
 */
function safeRmDir(targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) return;
  try {
    fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Non-fatal fallback
  }
}

/**
 * Cleans discrete messages and mailbox directory for a specific test agent.
 * @param {string} agentName
 * @param {string} [baseMeshDir]
 * @returns {number} count of pruned message files
 */
function cleanAgentMailbox(agentName, baseMeshDir = MESH_DIR) {
  if (!agentName) return 0;
  const inboxDir = path.join(baseMeshDir, 'inbox', agentName);
  if (!fs.existsSync(inboxDir)) return 0;

  let count = 0;
  try {
    const files = fs.readdirSync(inboxDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(inboxDir, f));
          count++;
        } catch {}
      }
    }
    // Remove the empty mailbox folder
    safeRmDir(inboxDir);
  } catch {}
  return count;
}

/**
 * Scans and cleans all mailboxes matching ephemeral test prefixes (e.g. 'test-', 'ephem-').
 * @param {RegExp} [pattern=EPHEMERAL_PREFIX_REGEX]
 * @param {string} [baseMeshDir]
 * @returns {number} count of pruned test mailboxes
 */
function cleanEphemeralMailboxes(pattern = EPHEMERAL_PREFIX_REGEX, baseMeshDir = MESH_DIR) {
  const inboxBase = path.join(baseMeshDir, 'inbox');
  if (!fs.existsSync(inboxBase)) return 0;

  let pruned = 0;
  try {
    const entries = fs.readdirSync(inboxBase, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && pattern.test(entry.name) && !PERMANENT_AGENTS.has(entry.name.toLowerCase())) {
        safeRmDir(path.join(inboxBase, entry.name));
        pruned++;
      }
    }
  } catch {}
  return pruned;
}

/**
 * Cleans stale NTFS locks left behind by interrupted tests.
 * @param {number} [maxAgeMs=5000]
 * @param {string} [baseMeshDir]
 * @returns {number} count of released stale locks
 */
function cleanStaleLocks(maxAgeMs = 5000, baseMeshDir = MESH_DIR) {
  const locksDir = path.join(baseMeshDir, 'locks');
  if (!fs.existsSync(locksDir)) return 0;

  let released = 0;
  const now = Date.now();
  try {
    const locks = fs.readdirSync(locksDir);
    for (const lk of locks) {
      const lockPath = path.join(locksDir, lk);
      try {
        const stat = fs.statSync(lockPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          safeRmDir(lockPath);
          released++;
        }
      } catch {}
    }
  } catch {}
  return released;
}

/**
 * Cleans peer heartbeat files created during test runs.
 * @param {RegExp} [pattern=/^(test|ephem|temp|stress)-/i]
 * @param {string} [baseMeshDir]
 * @returns {number} count of removed heartbeats
 */
function cleanTestHeartbeats(pattern = /^(test|ephem|temp|stress)-/i, baseMeshDir = MESH_DIR) {
  const hbDir = path.join(baseMeshDir, 'heartbeats');
  if (!fs.existsSync(hbDir)) return 0;

  let removed = 0;
  try {
    const files = fs.readdirSync(hbDir);
    for (const f of files) {
      if (f.endsWith('.json') && pattern.test(f)) {
        try {
          fs.unlinkSync(path.join(hbDir, f));
          removed++;
        } catch {}
      }
    }
  } catch {}
  return removed;
}

/**
 * Sweeps and cleans all test artifacts across inbox, legacy files, locks, and heartbeats.
 * @param {RegExp} [pattern=EPHEMERAL_PREFIX_REGEX]
 * @param {string} [baseMeshDir=MESH_DIR]
 * @returns {number} count of pruned items
 */
function cleanAllTestArtifacts(pattern = EPHEMERAL_PREFIX_REGEX, baseMeshDir = MESH_DIR) {
  let pruned = 0;

  // 1. Clean test inboxes
  const inboxBase = path.join(baseMeshDir, 'inbox');
  if (fs.existsSync(inboxBase)) {
    try {
      const entries = fs.readdirSync(inboxBase, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && pattern.test(entry.name) && !PERMANENT_AGENTS.has(entry.name.toLowerCase())) {
          safeRmDir(path.join(inboxBase, entry.name));
          pruned++;
        }
      }
    } catch {}
  }

  // 2. Clean legacy root JSON test files
  try {
    const rootFiles = fs.readdirSync(baseMeshDir);
    for (const f of rootFiles) {
      if (f.endsWith('.json') && pattern.test(f)) {
        const agentPart = f.replace(/\.json$/, '');
        if (!PERMANENT_AGENTS.has(agentPart.toLowerCase())) {
          try {
            fs.unlinkSync(path.join(baseMeshDir, f));
            pruned++;
          } catch {}
        }
      }
    }
  } catch {}

  // 3. Clean test locks
  pruned += cleanStaleLocks(1000, baseMeshDir);

  // 4. Clean test heartbeats
  pruned += cleanTestHeartbeats(pattern, baseMeshDir);

  return pruned;
}

/**
 * Standard test teardown executor that cleans agent mailbox, locks, and heartbeats.
 * @param {object} [options]
 */
function teardownAll(options = {}) {
  const baseMeshDir = options.meshDir || MESH_DIR;
  if (options.agent) {
    cleanAgentMailbox(options.agent, baseMeshDir);
  }
  cleanEphemeralMailboxes(options.pattern, baseMeshDir);
  cleanStaleLocks(options.lockMaxAgeMs || 2000, baseMeshDir);
  cleanTestHeartbeats(options.pattern, baseMeshDir);
}

module.exports = {
  safeRmDir,
  cleanAgentMailbox,
  cleanEphemeralMailboxes,
  cleanStaleLocks,
  cleanTestHeartbeats,
  cleanAllTestArtifacts,
  teardownAll,
  EPHEMERAL_PREFIX_REGEX,
  PERMANENT_AGENTS
};

