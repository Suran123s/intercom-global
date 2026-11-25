// src/core/jules-delegator.js - Google Jules Delegation Routing, Limits & Governance
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const julesBridge = require('../bridges/jules-bridge');
const { getMeshDir } = require('../config');
const { withLock, withLockSync, atomicWriteFileSync } = require('./mesh');

class FileBoundaryExceededError extends Error {
  constructor(message, fileCount, files) {
    super(message);
    this.name = 'FileBoundaryExceededError';
    this.fileCount = fileCount;
    this.files = files;
  }
}

const JULES_LIMITS = {
  MAX_FILES: 3,
  MAX_CONCURRENT_SESSIONS: 15,
  MAX_DAILY_SESSIONS: 100,
  HEAVY_LOC_THRESHOLD: 100,
  EXTENSIVE_TEST_THRESHOLD: 50
};

const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function parsePositiveInt(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = parseInt(String(val), 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function getJulesLimits() {
  let fileConfig = {};
  try {
    const cfgPath = path.join(path.dirname(getMeshDir()), 'jules.config.json');
    if (fs.existsSync(cfgPath)) {
      fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {};
    }
  } catch {}

  return {
    MAX_FILES: parsePositiveInt(process.env.JULES_MAX_FILES, fileConfig.MAX_FILES ?? JULES_LIMITS.MAX_FILES),
    MAX_CONCURRENT_SESSIONS: parsePositiveInt(
      process.env.JULES_MAX_CONCURRENT_SESSIONS,
      fileConfig.MAX_CONCURRENT_SESSIONS ?? JULES_LIMITS.MAX_CONCURRENT_SESSIONS
    ),
    MAX_DAILY_SESSIONS: parsePositiveInt(
      process.env.JULES_MAX_DAILY_SESSIONS,
      fileConfig.MAX_DAILY_SESSIONS ?? JULES_LIMITS.MAX_DAILY_SESSIONS
    ),
    HEAVY_LOC_THRESHOLD: parsePositiveInt(
      process.env.JULES_HEAVY_LOC_THRESHOLD,
      fileConfig.HEAVY_LOC_THRESHOLD ?? JULES_LIMITS.HEAVY_LOC_THRESHOLD
    ),
    EXTENSIVE_TEST_THRESHOLD: parsePositiveInt(
      process.env.JULES_EXTENSIVE_TEST_THRESHOLD,
      fileConfig.EXTENSIVE_TEST_THRESHOLD ?? JULES_LIMITS.EXTENSIVE_TEST_THRESHOLD
    )
  };
}

function getSessionTtlMs() {
  return parsePositiveInt(process.env.JULES_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS);
}

function getLedgerPath() {
  const explicitFile = process.env.JULES_LEDGER_FILE && process.env.JULES_LEDGER_FILE.trim();
  if (explicitFile) {
    const resolved = path.isAbsolute(explicitFile) ? explicitFile : path.resolve(process.cwd(), explicitFile);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
    return resolved;
  }

  const meshEnv = process.env.INTERCOM_MESH_DIR && process.env.INTERCOM_MESH_DIR.trim();
  const dir = meshEnv ? getMeshDir() : path.join(os.homedir(), '.intercom-global');
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
  return path.join(dir, 'jules-ledger.json');
}

function getLedgerLockMeshDir() {
  const meshEnv = process.env.INTERCOM_MESH_DIR && process.env.INTERCOM_MESH_DIR.trim();
  return meshEnv ? getMeshDir() : path.dirname(getLedgerPath());
}

function pruneStaleSessions(ledger, ttlMs = getSessionTtlMs()) {
  if (!ledger || !Array.isArray(ledger.activeSessions)) return false;
  if (ttlMs <= 0) return false;
  const now = Date.now();
  const before = ledger.activeSessions.length;
  ledger.activeSessions = ledger.activeSessions.filter((s) => {
    if (!s || typeof s !== 'object') return false;
    if (!s.startedAt) return true;
    const startedMs = new Date(s.startedAt).getTime();
    if (!Number.isFinite(startedMs)) return true;
    return (now - startedMs) <= ttlMs;
  });
  return ledger.activeSessions.length !== before;
}

function readLedgerUnlocked() {
  const filePath = getLedgerPath();
  const today = new Date().toISOString().slice(0, 10);
  const defaultLedger = {
    dailyDate: today,
    dailyCount: 0,
    activeSessions: []
  };

  if (!fs.existsSync(filePath)) {
    return defaultLedger;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultLedger;

    // Reset daily count if date has rolled over
    if (parsed.dailyDate !== today) {
      parsed.dailyDate = today;
      parsed.dailyCount = 0;
    }
    if (!Array.isArray(parsed.activeSessions)) {
      parsed.activeSessions = [];
    }
    return parsed;
  } catch {
    return defaultLedger;
  }
}

function writeLedgerUnlocked(ledger) {
  const filePath = getLedgerPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    atomicWriteFileSync(filePath, JSON.stringify(ledger, null, 2));
  } catch {
    const tmp = `${filePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    }
  }
}

function readLedger() {
  const ledger = readLedgerUnlocked();
  pruneStaleSessions(ledger);
  return ledger;
}

function writeLedger(ledger) {
  return withLockSync('jules_ledger', () => {
    writeLedgerUnlocked(ledger);
  }, { meshDir: getLedgerLockMeshDir() });
}

/**
 * Classifies a coding task to determine optimal routing
 * Routes single-file heavy edits (>100 LOC modifications, complex AST rewrites, or extensive test suites) to Jules
 * @param {object} taskSpec
 * @returns {{ route: 'JULES'|'LOCAL_WORKER'|'IN_SITU_ANTIGRAVITY', reason: string, isHeavy: boolean, fileCount: number, needsPartitioning: boolean }}
 */
function classifyTask(taskSpec = {}) {
  const limits = getJulesLimits();
  const targetFiles = Array.isArray(taskSpec.targetFiles)
    ? taskSpec.targetFiles.filter(Boolean)
    : (taskSpec.file ? [taskSpec.file] : []);
  const fileCount = targetFiles.length;
  const loc = taskSpec.locModifications || taskSpec.loc || 0;
  const testCount = taskSpec.testCount || 0;
  const desc = ((taskSpec.description || '') + ' ' + (taskSpec.prompt || '')).toLowerCase();

  const isAstRewrite = taskSpec.isAstRewrite === true ||
    desc.includes('ast rewrite') ||
    desc.includes('ast refactor') ||
    desc.includes('parser overhaul') ||
    desc.includes('syntax tree');

  const isExtensiveTests = testCount >= limits.EXTENSIVE_TEST_THRESHOLD ||
    desc.includes('extensive test suite') ||
    desc.includes('broad test generation') ||
    desc.includes('50+ tests');

  const isHeavyLoc = loc >= limits.HEAVY_LOC_THRESHOLD ||
    desc.includes('>100 loc') ||
    desc.includes('heavy edit') ||
    desc.includes('heavy-lift') ||
    desc.includes('major overhaul');

  const isHeavy = isHeavyLoc || isAstRewrite || isExtensiveTests;
  const needsPartitioning = fileCount > limits.MAX_FILES;

  if (needsPartitioning) {
    return {
      route: 'LOCAL_WORKER',
      reason: `Task touches ${fileCount} files, exceeding Jules 1-${limits.MAX_FILES} files boundary. Must be partitioned into single-file dispatches coordinated by local teamwork agents.`,
      isHeavy,
      fileCount,
      needsPartitioning: true
    };
  }

  if (isHeavy && fileCount >= 1 && fileCount <= limits.MAX_FILES) {
    return {
      route: 'JULES',
      reason: `Single-file or bounded (${fileCount} files) heavy edit detected (${isHeavyLoc ? loc + ' LOC' : (isAstRewrite ? 'AST rewrite' : 'extensive test suite')}). Optimal for Google Jules cloud VM offloading.`,
      isHeavy: true,
      fileCount,
      needsPartitioning: false
    };
  }

  if (loc > 0 && loc < 25 && fileCount === 1) {
    return {
      route: 'IN_SITU_ANTIGRAVITY',
      reason: `Contained edit (${loc} LOC, 1 file). Direct in-situ execution is fastest.`,
      isHeavy: false,
      fileCount,
      needsPartitioning: false
    };
  }

  return {
    route: 'LOCAL_WORKER',
    reason: `Standard task scope (${fileCount} files, ${loc} LOC). Best handled by local teamwork subagent cell.`,
    isHeavy: false,
    fileCount,
    needsPartitioning: false
  };
}

/**
 * Partitions an array of target files into chunks of 1 to 3 files
 * @param {string[]} files
 * @param {number} maxPerChunk
 * @returns {string[][]}
 */
function partitionFiles(files, maxPerChunk = getJulesLimits().MAX_FILES) {
  if (!Array.isArray(files)) return [];
  const chunks = [];
  for (let i = 0; i < files.length; i += maxPerChunk) {
    chunks.push(files.slice(i, i + maxPerChunk));
  }
  return chunks;
}

/**
 * Validates target files against strict 1-3 files boundary
 * @param {string[]} files
 * @param {boolean} autoPartition (default: false)
 * @returns {string[][]} Array of partitioned file arrays
 * @throws {FileBoundaryExceededError} if >3 files and autoPartition is false
 */
function validateFileBoundary(files, autoPartition = false) {
  const limits = getJulesLimits();
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('targetFiles must be a non-empty array of file paths');
  }

  if (files.length > limits.MAX_FILES) {
    if (!autoPartition) {
      throw new FileBoundaryExceededError(
        `File Boundary Exceeded: Google Jules dispatches must strictly target 1 to ${limits.MAX_FILES} files (received: ${files.length}). Multi-file spans must be broken into single-file dispatches coordinated by teamwork agents.`,
        files.length,
        files
      );
    }
    return partitionFiles(files, limits.MAX_FILES);
  }

  return [files];
}

/**
 * Generates unambiguous 5-Pillar Markdown prompt with fixing values
 * Adheres strictly to .agents/rules/jules-delegation.md Lines 36-54
 * @param {object} spec
 * @returns {string} Formatted Markdown prompt
 */
function generatePillars(spec = {}) {
  const targetFiles = Array.isArray(spec.targetFiles) ? spec.targetFiles : (spec.file ? [spec.file] : []);
  const targetLines = spec.targetLines || 'Entire specified module';
  const symptomContext = spec.symptomContext || spec.reproductionContext || spec.errorLog || 'None specified';
  const acceptanceCriteria = Array.isArray(spec.acceptanceCriteria)
    ? spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : (spec.acceptanceCriteria || '1. Clean compilation and passing tests');
  const testCommand = spec.testCommand || 'npm test';
  const lintCommand = spec.lintCommand || 'npm run lint';
  const boundaries = Array.isArray(spec.boundaries)
    ? spec.boundaries.map((b) => `- ${b}`).join('\n')
    : (spec.boundaries || '- Only modify target files; do not refactor outside scope');

  return `# GOOGLE JULES TASK SPECIFICATION (5-PILLAR FIXING VALUES)

## Pillar 1: Exact Target Files & Scope
- **Target Files**:
${targetFiles.map(f => `  - \`${f}\``).join('\n')}
- **Target Lines / Code Span**: ${targetLines}
- **Task Summary**: ${spec.summary || spec.title || 'Execute targeted heavy edit overhaul'}

## Pillar 2: Observed Symptom & Reproduction Context
\`\`\`text
${symptomContext}
\`\`\`

## Pillar 3: Concrete Acceptance Criteria
${acceptanceCriteria}

## Pillar 4: Mandatory Verification & Test Commands
- **Primary Test Command**: \`${testCommand}\`
- **Lint Verification**: \`${lintCommand}\`
- **Exit Criteria**: All tests pass cleanly with exit code 0; zero regressions.

## Pillar 5: Strict Guardrails & Non-Goals
${boundaries}
- **Integrity Directive**: Real implementation only. No hardcoded outputs, facade methods, or bypassed validations.
`;
}

/**
 * Validates that a Jules prompt or spec contains all 5 required fixing-value pillars
 * @param {object|string} promptOrSpec
 * @returns {boolean}
 * @throws {Error} if any pillar is missing or invalid
 */
function validateJulesPrompt(promptOrSpec) {
  const limits = getJulesLimits();
  if (!promptOrSpec) {
    throw new Error('Prompt specification is required');
  }

  if (typeof promptOrSpec === 'string') {
    const p = promptOrSpec;
    const requiredHeadings = [
      'Pillar 1:',
      'Pillar 2:',
      'Pillar 3:',
      'Pillar 4:',
      'Pillar 5:'
    ];
    for (const h of requiredHeadings) {
      if (!p.includes(h)) {
        throw new Error(`Invalid Jules prompt: Missing mandatory 5-pillar heading "${h}"`);
      }
    }
    return true;
  }

  const spec = promptOrSpec;
  const targetFiles = Array.isArray(spec.targetFiles) ? spec.targetFiles.filter(Boolean) : (spec.file ? [spec.file] : []);

  if (targetFiles.length < 1 || targetFiles.length > limits.MAX_FILES) {
    throw new FileBoundaryExceededError(
      `File Boundary Exceeded: Jules dispatches must target 1 to ${limits.MAX_FILES} files. Received: ${targetFiles.length}`,
      targetFiles.length,
      targetFiles
    );
  }

  const requiredFields = [
    { key: 'targetFiles', name: 'Pillar 1 (Target Files)' },
    { key: 'symptomContext', alt: ['reproductionContext', 'errorLog'], name: 'Pillar 2 (Symptom/Reproduction Context)' },
    { key: 'acceptanceCriteria', name: 'Pillar 3 (Acceptance Criteria)' },
    { key: 'testCommand', name: 'Pillar 4 (Test Commands)' },
    { key: 'boundaries', alt: ['nonGoals', 'guardrails'], name: 'Pillar 5 (Guardrails/Non-Goals)' }
  ];

  for (const field of requiredFields) {
    const val = spec[field.key] || (field.alt && field.alt.map(k => spec[k]).find(Boolean));
    if (!val || (Array.isArray(val) && val.length === 0)) {
      throw new Error(`Missing mandatory 5-pillar fixing value: ${field.name}`);
    }
  }

  return true;
}

function evaluateQuotaAgainstLedger(ledger, limits) {
  const activeCount = ledger.activeSessions.length;
  const dailyCount = ledger.dailyCount;

  if (activeCount >= limits.MAX_CONCURRENT_SESSIONS) {
    return {
      available: false,
      activeSessions: activeCount,
      dailySessions: dailyCount,
      quotaExceeded: true,
      reason: `Jules concurrency cap reached: ${activeCount}/${limits.MAX_CONCURRENT_SESSIONS} active sessions.`
    };
  }

  if (dailyCount >= limits.MAX_DAILY_SESSIONS) {
    return {
      available: false,
      activeSessions: activeCount,
      dailySessions: dailyCount,
      quotaExceeded: true,
      reason: `Jules daily session cap reached: ${dailyCount}/${limits.MAX_DAILY_SESSIONS} daily sessions.`
    };
  }

  return {
    available: true,
    activeSessions: activeCount,
    dailySessions: dailyCount,
    quotaExceeded: false
  };
}

/**
 * Checks Jules concurrency and daily quota limits under CAS lock
 * @param {object} options { dryRun?: boolean, syncRemote?: boolean }
 * @returns {Promise<{ available: boolean, activeSessions: number, dailySessions: number, quotaExceeded: boolean, reason?: string }>}
 */
async function checkQuota(options = {}) {
  const limits = getJulesLimits();
  let liveSessions = null;

  // Optionally query live sessions outside lock to avoid holding lock over subprocess call
  if (options.syncRemote && !options.dryRun) {
    try {
      const live = await julesBridge.listSessions();
      liveSessions = live
        .filter(s => s.status === 'EXECUTING' || s.status === 'PLANNING' || s.status === 'QUEUED')
        .map(s => ({
          id: s.id,
          startedAt: s.timestamp || new Date().toISOString()
        }));
    } catch {}
  }

  return withLock('jules_ledger', async () => {
    const ledger = readLedgerUnlocked();
    if (liveSessions !== null) {
      ledger.activeSessions = liveSessions;
      writeLedgerUnlocked(ledger);
    } else {
      const pruned = pruneStaleSessions(ledger);
      if (pruned && !options.dryRun) {
        writeLedgerUnlocked(ledger);
      }
    }
    return evaluateQuotaAgainstLedger(ledger, limits);
  }, { meshDir: getLedgerLockMeshDir() });
}

/**
 * Handles automatic fallback routing when Jules is throttled or unavailable
 * Invariant: sets disallowJulesReDelegation: true to prevent recursive fallback
 * @param {object} taskSpec
 * @param {string} failureReason
 * @param {object} options
 * @returns {{ fallbackActivated: true, type: 'IN_SITU'|'TEAMWORK_WORKER', reason: string, disallowJulesReDelegation: true, taskSpec: object }}
 */
function handleFallback(taskSpec = {}, failureReason, options = {}) {
  const targetFiles = Array.isArray(taskSpec.targetFiles)
    ? taskSpec.targetFiles.filter(Boolean)
    : (taskSpec.file ? [taskSpec.file] : []);
  const loc = taskSpec.locModifications || 0;

  // Fallback A: Contained, small changes executed in-situ by Antigravity
  // Fallback B: Large, multi-file or broad changes delegated to teamwork subagents
  const isSmall = targetFiles.length <= 1 && loc < 50;
  const fallbackType = isSmall ? 'IN_SITU' : 'TEAMWORK_WORKER';

  return {
    fallbackActivated: true,
    type: fallbackType,
    reason: failureReason || 'Jules offloading unavailable or quota throttled',
    disallowJulesReDelegation: true,
    taskSpec: {
      ...taskSpec,
      disallowJulesReDelegation: true
    }
  };
}

/**
 * Full orchestration entry point: validates boundary, checks quota, generates 5 pillars, and dispatches
 * @param {object} taskSpec
 * @param {object} options { dryRun?: boolean, autoPartition?: boolean }
 * @returns {Promise<object>}
 */
async function dispatchTask(taskSpec = {}, options = {}) {
  const spec = taskSpec || {};
  // If fallback flag already set, prevent recursive loop
  if (spec.disallowJulesReDelegation === true) {
    return handleFallback(spec, 'Task marked with disallowJulesReDelegation: true');
  }

  // 1. Classify Task
  const classification = classifyTask(spec);
  if (classification.route !== 'JULES' && !options.forceJules) {
    return handleFallback(spec, `Task classification decided: ${classification.route} (${classification.reason})`);
  }

  // 2. Validate File Boundary (1-3 files)
  const targetFiles = Array.isArray(spec.targetFiles)
    ? spec.targetFiles.filter(Boolean)
    : (spec.file ? [spec.file] : []);
  validateFileBoundary(targetFiles, options.autoPartition === true);

  // 3. Pre-Flight Quota Check (under CAS lock)
  const quota = await checkQuota(options);
  if (!quota.available) {
    return handleFallback(spec, quota.reason);
  }

  // 4. Verify Jules Environment
  const env = await julesBridge.checkJulesEnvironment(options);
  if (!env.installed || !env.authenticated) {
    return handleFallback(
      spec,
      `Jules environment check failed (installed: ${env.installed}, authenticated: ${env.authenticated})`
    );
  }

  // 5. Generate 5-Pillar Prompt
  const prompt = generatePillars({ ...spec, targetFiles });
  validateJulesPrompt(prompt);

  // 6. Dispatch via Jules Bridge
  const sessionResult = await julesBridge.newSession(prompt, {
    repo: spec.repo,
    parallel: spec.parallel,
    dryRun: options.dryRun
  });

  // 7. Atomic CAS-locked check-increment-write on ledger
  const limits = getJulesLimits();
  const ledgerSummary = await withLock('jules_ledger', async () => {
    const ledger = readLedgerUnlocked();
    pruneStaleSessions(ledger);
    const currentQuota = evaluateQuotaAgainstLedger(ledger, limits);
    if (!currentQuota.available) {
      return { quotaExceeded: true, reason: currentQuota.reason };
    }
    ledger.dailyCount += 1;
    ledger.activeSessions.push({
      id: sessionResult.sessionId,
      startedAt: new Date().toISOString(),
      files: targetFiles,
      repo: sessionResult.repo
    });
    writeLedgerUnlocked(ledger);
    return {
      quotaExceeded: false,
      activeSessions: ledger.activeSessions.length,
      dailyCount: ledger.dailyCount
    };
  }, { meshDir: getLedgerLockMeshDir() });

  if (ledgerSummary.quotaExceeded) {
    return handleFallback(spec, ledgerSummary.reason);
  }

  return {
    status: 'DISPATCHED',
    sessionId: sessionResult.sessionId,
    route: 'JULES',
    prompt,
    pillars: 5,
    files: targetFiles,
    ledger: {
      activeSessions: ledgerSummary.activeSessions,
      dailyCount: ledgerSummary.dailyCount
    }
  };
}

module.exports = {
  JULES_LIMITS,
  getJulesLimits,
  getLedgerPath,
  FileBoundaryExceededError,
  classifyTask,
  partitionFiles,
  validateFileBoundary,
  generatePillars,
  validateJulesPrompt,
  checkQuota,
  handleFallback,
  dispatchTask,
  readLedger,
  writeLedger
};
