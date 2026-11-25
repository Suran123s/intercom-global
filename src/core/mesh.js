// src/core/mesh.js - Zero-Loss Discrete Atomic File-Mesh & Deadlock-Free CAS Advisory Locking
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getMeshDir } = require('../config');
const { MessageEnvelope } = require('./message');

// Strict path traversal and DOS device regexes (ARCHITECTURE.md Section 8)
const PATH_TRAVERSAL_REGEX = /(\.\.|\/|\\|%2e%2e|%2f|%5c)/i;
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_\-]+$/;
const DOS_DEVICE_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$|CLOCK\$)(\..*)?$/i;

class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityError';
  }
}

class LockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

/**
 * Validates an agent identifier string strictly rejecting path traversal and DOS devices
 * @param {string} name 
 * @returns {string} clean name
 */
function validateAgentName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new SecurityError('Invalid input: path component must be a non-empty string');
  }
  const trimmed = name.trim();
  if (trimmed.includes('\0')) {
    throw new SecurityError('Invalid input: null byte rejected');
  }
  if (PATH_TRAVERSAL_REGEX.test(trimmed)) {
    throw new SecurityError(`Path traversal attack rejected: "${trimmed}" contains illegal traversal tokens`);
  }
  if (DOS_DEVICE_REGEX.test(trimmed)) {
    throw new SecurityError(
      `Reserved Windows DOS/Win32 device name rejected: "${trimmed}". Extended device handles (CONIN$, CONOUT$, CLOCK$) are prohibited.`
    );
  }
  if (!SAFE_IDENTIFIER_REGEX.test(trimmed)) {
    throw new SecurityError(
      `Invalid agent identifier: "${trimmed}". Only alphanumeric, hyphen, and underscore characters are allowed.`
    );
  }
  return trimmed;
}

/**
 * Sanitizes an agent name into a safe identifier
 * @param {string} name 
 * @returns {string}
 */
function sanitizeAgentName(name) {
  if (typeof name !== 'string') return 'unknown';
  let clean = name.replace(/\0/g, '').replace(/\\/g, '/');
  clean = path.basename(clean);
  clean = clean.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/^_+/, '');
  if (!clean || DOS_DEVICE_REGEX.test(clean)) {
    clean = clean ? `${clean}_safe` : 'agent_default';
  }
  return clean;
}

const ILLEGAL_CHARS_REGEX = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const TRAILING_DOTS_SPACES_REGEX = /[\s.]+$/;
const URL_ENCODED_REGEX = /(%2e|%2f|%5c|%00)/i;

function assertWithinBaseDir(baseDir, userInput, rawInput) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, rawInput);
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  const isWin = process.platform === 'win32';
  const normBase = isWin ? baseWithSep.toLowerCase() : baseWithSep;
  const normBaseExact = isWin ? resolvedBase.toLowerCase() : resolvedBase;
  const normTarget = isWin ? resolvedTarget.toLowerCase() : resolvedTarget;

  if (!normTarget.startsWith(normBase) && normTarget !== normBaseExact) {
    throw new SecurityError(`Directory jail violation: "${userInput}" resolves outside "${baseDir}"`);
  }
  return resolvedTarget;
}

/**
 * Resolves safe path within baseDir, preventing directory breakout, ADS streams, and null bytes
 * @param {string} baseDir 
 * @param {string} userInput 
 * @returns {string}
 */
function resolveSafePath(baseDir, userInput) {
  if (typeof userInput !== 'string' || userInput.trim() === '') {
    throw new SecurityError('Invalid input: path component must be a non-empty string');
  }
  if (userInput.includes('\0')) {
    throw new SecurityError('Invalid input: null byte rejected');
  }
  const raw = userInput.trim();
  if (URL_ENCODED_REGEX.test(raw)) {
    throw new SecurityError(`Path traversal attack rejected: "${raw}" contains encoded traversal tokens`);
  }
  if (raw.includes(':')) {
    throw new SecurityError(`NTFS Alternate Data Stream (ADS) or drive-letter attack rejected: "${raw}" contains illegal colon`);
  }
  if (PATH_TRAVERSAL_REGEX.test(raw)) {
    throw new SecurityError(`Path traversal attack rejected: "${raw}" contains illegal traversal tokens`);
  }
  return assertWithinBaseDir(baseDir, userInput, raw);
}

/**
 * Rigorously sanitizes an input string into a safe Windows NTFS filename
 * @param {string} name 
 * @param {string} [fallback='safe_file'] 
 * @returns {string} clean filename
 */
function sanitizeWindowsFilename(name, fallback = 'safe_file') {
  if (typeof name !== 'string') return fallback;

  let clean = name.replace(/\0/g, '').trim();
  try {
    clean = decodeURIComponent(clean);
  } catch {}

  clean = path.basename(clean.replace(/\\/g, '/'));
  clean = clean.replace(ILLEGAL_CHARS_REGEX, '_');
  clean = clean.replace(TRAILING_DOTS_SPACES_REGEX, '');

  if (!clean || DOS_DEVICE_REGEX.test(clean)) {
    clean = clean ? `safe_${clean}` : fallback;
  }

  if (clean.length > 255) {
    clean = clean.slice(0, 255);
    clean = clean.replace(TRAILING_DOTS_SPACES_REGEX, '');
  }

  return clean || fallback;
}

/**
 * Rigorously validates and resolves a safe path within a base directory,
 * preventing Windows path traversal, ADS streams, null bytes, and directory jail breakouts.
 * @param {string} baseDir 
 * @param {string} userInput 
 * @returns {string} safe absolute path
 */
function sanitizeWindowsPath(baseDir, userInput) {
  if (typeof userInput !== 'string' || userInput.trim() === '') {
    throw new SecurityError('Invalid input: path component must be a non-empty string');
  }
  if (userInput.includes('\0')) {
    throw new SecurityError('Invalid input: null byte rejected');
  }

  const raw = userInput.trim();

  if (URL_ENCODED_REGEX.test(raw)) {
    throw new SecurityError(`Path traversal attack rejected: "${raw}" contains encoded traversal tokens`);
  }

  if (raw.includes(':')) {
    throw new SecurityError(`NTFS Alternate Data Stream (ADS) attack rejected: "${raw}" contains illegal colon`);
  }

  if (PATH_TRAVERSAL_REGEX.test(raw)) {
    throw new SecurityError(`Path traversal attack rejected: "${raw}" contains traversal tokens`);
  }

  return assertWithinBaseDir(baseDir, userInput, raw);
}

let _sharedSleepInt32 = null;
/**
 * Non-spinning synchronous sleep using Atomics.wait (never burns CPU in a tight Date.now() loop).
 * @param {number} ms
 */
function sleepSyncSafe(ms) {
  const delayMs = Math.max(0, Math.min(Math.round(Number(ms) || 0), 30000));
  if (delayMs <= 0) return;
  if (!_sharedSleepInt32) {
    try {
      _sharedSleepInt32 = new Int32Array(new SharedArrayBuffer(4));
    } catch {}
  }
  if (_sharedSleepInt32) {
    try {
      Atomics.wait(_sharedSleepInt32, 0, 0, delayMs);
    } catch {}
  }
}

/**
 * Dual-sided 5-attempt exponential backoff retry loop on Windows NTFS EBUSY/EPERM/EACCES errors
 * Schedule: 20ms, 40ms, 80ms, 160ms, 320ms (+ randomized jitter 0-15ms)
 */
async function retryNtfsOperation(fn, maxAttempts = 5) {
  let attempt = 0;
  const delays = [20, 40, 80, 160, 320];

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const isLockError = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!isLockError || attempt >= maxAttempts) {
        throw err;
      }
      const baseDelay = delays[attempt - 1] || 320;
      const jitter = Math.floor(Math.random() * 16);
      await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
    }
  }
}

/**
 * Synchronous variant of NTFS retry operation
 */
function retryNtfsOperationSync(fn, maxAttempts = 5) {
  let attempt = 0;
  const delays = [20, 40, 80, 160, 320];

  while (true) {
    try {
      return fn();
    } catch (err) {
      attempt++;
      const isLockError = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!isLockError || attempt >= maxAttempts) {
        throw err;
      }
      const baseDelay = delays[attempt - 1] || 320;
      const jitter = Math.floor(Math.random() * 16);
      const totalDelay = baseDelay + jitter;
      sleepSyncSafe(totalDelay);
    }
  }
}

/**
 * Atomically writes data to targetPath via a unique temporary file + rename with NTFS retry and cleanup.
 * @param {string} targetPath
 * @param {string|Buffer} data
 * @param {string} [encoding='utf8']
 */
async function atomicWriteFile(targetPath, data, encoding = 'utf8') {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`);

  await fs.promises.mkdir(dir, { recursive: true });
  try {
    await retryNtfsOperation(() => fs.promises.writeFile(tmpPath, data, encoding));
    await retryNtfsOperation(() => fs.promises.rename(tmpPath, targetPath));
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        await retryNtfsOperation(() => fs.promises.unlink(tmpPath));
      }
    } catch {}
  }
}

/**
 * Synchronous atomic write via unique temporary file + rename with NTFS retry and cleanup.
 * @param {string} targetPath
 * @param {string|Buffer} data
 * @param {string} [encoding='utf8']
 */
function atomicWriteFileSync(targetPath, data, encoding = 'utf8') {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    retryNtfsOperationSync(() => fs.writeFileSync(tmpPath, data, encoding));
    retryNtfsOperationSync(() => fs.renameSync(tmpPath, targetPath));
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        retryNtfsOperationSync(() => fs.unlinkSync(tmpPath));
      }
    } catch {}
  }
}

/**
 * Ensures standard mesh subdirectories exist
 * @param {string} [meshDir]
 */
function ensureMeshDirs(meshDir = getMeshDir()) {
  const dirs = [
    meshDir,
    path.join(meshDir, 'inbox'),
    path.join(meshDir, 'locks'),
    path.join(meshDir, 'archive'),
    path.join(meshDir, 'registry'),
    path.join(meshDir, 'interrupts'),
    path.join(meshDir, 'handoffs'),
    path.join(meshDir, 'heartbeats'),
    path.join(meshDir, 'sessions'),
    path.join(meshDir, 'dlq'),
    path.join(meshDir, 'dlq', 'poison')
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch {}
    }
  }
}

/**
 * Returns the inbox directory for a given agent
 * @param {string} agentName 
 * @param {string} [meshDir]
 * @returns {string}
 */
function getInboxDir(agentName, meshDir = getMeshDir()) {
  const clean = validateAgentName(agentName);
  const inboxBase = path.join(meshDir, 'inbox');
  const target = resolveSafePath(inboxBase, clean);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  return target;
}

async function mirrorAntigravityInbox(cleanRecipient, finalFileName, serialized, primaryInboxDir) {
  if (cleanRecipient.toLowerCase() !== 'antigravity') return;
  try {
    const workspaceInbox = path.resolve(process.cwd(), '.agents', 'mesh', 'inbox', 'antigravity');
    if (workspaceInbox !== primaryInboxDir) {
      await atomicWriteFile(path.join(workspaceInbox, finalFileName), serialized);
    }
  } catch {}
}

function mirrorAntigravityInboxSync(cleanRecipient, finalFileName, serialized, primaryInboxDir) {
  if (cleanRecipient.toLowerCase() !== 'antigravity') return;
  try {
    const workspaceInbox = path.resolve(process.cwd(), '.agents', 'mesh', 'inbox', 'antigravity');
    if (workspaceInbox !== primaryInboxDir) {
      atomicWriteFileSync(path.join(workspaceInbox, finalFileName), serialized);
    }
  } catch {}
}

/**
 * Generic Least-Recently-Used (LRU) Cache backed by ES6 Map insertion ordering.
 * Guarantees O(1) get and set with automatic bound enforcement.
 */
class LruCache {
  /**
   * @param {number} maxEntries - Maximum number of items before LRU eviction
   */
  constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.evictions++;
      }
    }
    this.cache.set(key, value);
    return this;
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  keys() {
    return this.cache.keys();
  }

  values() {
    return this.cache.values();
  }

  entries() {
    return this.cache.entries();
  }

  [Symbol.iterator]() {
    return this.cache[Symbol.iterator]();
  }

  forEach(callback, thisArg) {
    return this.cache.forEach(callback, thisArg);
  }

  getStats() {
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions
    };
  }
}

// Bounded in-memory caches
const MAX_INBOX_DIR_CACHE_ENTRIES = 500;
const MAX_FILE_CACHE_ENTRIES = 5000;

const inboxDirCache = new LruCache(MAX_INBOX_DIR_CACHE_ENTRIES);
const fileEnvelopeCache = new LruCache(MAX_FILE_CACHE_ENTRIES);

/**
 * Invalidates cached inbox directory and optional envelope file entries.
 * @param {string} inboxDir
 * @param {string} [filePath]
 */
function invalidateInboxCache(inboxDir, filePath = null) {
  if (inboxDir) inboxDirCache.delete(inboxDir);
  if (filePath) fileEnvelopeCache.delete(filePath);
}

/**
 * Resets the in-memory inbox and file payload caches
 */
function clearMeshCache() {
  inboxDirCache.clear();
  fileEnvelopeCache.clear();
}

function getMeshCacheStats() {
  return {
    inboxDirCache: inboxDirCache.getStats(),
    fileEnvelopeCache: fileEnvelopeCache.getStats()
  };
}

function normalizeEnvelope(cleanRecipient, envelopeData) {
  if (envelopeData instanceof MessageEnvelope) return envelopeData;
  if (envelopeData && typeof envelopeData.toJSON === 'function') return envelopeData;
  return MessageEnvelope.create({ ...envelopeData, recipient: cleanRecipient });
}

function buildEnvelopeFromParsed(parsed) {
  const env = new MessageEnvelope(parsed);
  if (parsed && parsed.status !== undefined) env.status = parsed.status;
  if (parsed && parsed.statusUpdatedAt !== undefined) env.statusUpdatedAt = parsed.statusUpdatedAt;
  if (parsed && parsed.result !== undefined) env.result = parsed.result;
  if (parsed && parsed.deadLetterReason !== undefined) env.deadLetterReason = parsed.deadLetterReason;
  return env;
}

function freezeEnvelopeDeep(env) {
  if (!env || typeof env !== 'object') return env;
  if (env.payload && typeof env.payload === 'object') Object.freeze(env.payload);
  if (env.metadata && typeof env.metadata === 'object') Object.freeze(env.metadata);
  return Object.freeze(env);
}

function cloneEnvelope(env) {
  if (!env) return env;
  const raw = typeof env.toJSON === 'function' ? env.toJSON() : { ...env };
  if (raw.payload && typeof raw.payload === 'object') {
    raw.payload = typeof structuredClone === 'function'
      ? structuredClone(raw.payload)
      : JSON.parse(JSON.stringify(raw.payload));
  }
  if (raw.metadata && typeof raw.metadata === 'object') {
    raw.metadata = typeof structuredClone === 'function'
      ? structuredClone(raw.metadata)
      : JSON.parse(JSON.stringify(raw.metadata));
  }
  const cloned = new MessageEnvelope(raw);
  if (env.status !== undefined) cloned.status = env.status;
  if (env.statusUpdatedAt !== undefined) cloned.statusUpdatedAt = env.statusUpdatedAt;
  if (env.result !== undefined) cloned.result = env.result;
  if (env.deadLetterReason !== undefined) cloned.deadLetterReason = env.deadLetterReason;
  return cloned;
}

/**
 * Writes a discrete message envelope atomically into the recipient's inbox
 * Pattern: mesh/inbox/<recipient>/<timestamp>_<uuid>.json
 * @param {string} recipient 
 * @param {MessageEnvelope|object} envelopeData 
 * @param {object} [options]
 * @returns {Promise<{ messageId: string, path: string, envelope: MessageEnvelope }>}
 */
async function writeMessage(recipient, envelopeData, options = {}) {
  const cleanRecipient = validateAgentName(recipient);
  const meshDir = (options && options.meshDir) || getMeshDir();
  const envelope = normalizeEnvelope(cleanRecipient, envelopeData);

  const inboxDir = getInboxDir(cleanRecipient, meshDir);
  const finalFileName = `${envelope.epochMs}_${envelope.id}.json`;
  const finalFilePath = path.join(inboxDir, finalFileName);
  const serialized = JSON.stringify(envelope.toJSON ? envelope.toJSON() : envelope, null, 2);

  await atomicWriteFile(finalFilePath, serialized);
  await mirrorAntigravityInbox(cleanRecipient, finalFileName, serialized, inboxDir);

  invalidateInboxCache(inboxDir, finalFilePath);

  return {
    messageId: envelope.id,
    path: finalFilePath,
    envelope
  };
}

/**
 * Synchronous variant of discrete atomic message writing
 * @param {string} recipient 
 * @param {MessageEnvelope|object} envelopeData 
 * @param {object} [options]
 * @returns {{ messageId: string, path: string, envelope: MessageEnvelope }}
 */
function writeMessageSync(recipient, envelopeData, options = {}) {
  const cleanRecipient = validateAgentName(recipient);
  const meshDir = (options && options.meshDir) || getMeshDir();
  const envelope = normalizeEnvelope(cleanRecipient, envelopeData);

  const inboxDir = getInboxDir(cleanRecipient, meshDir);
  const finalFileName = `${envelope.epochMs}_${envelope.id}.json`;
  const finalFilePath = path.join(inboxDir, finalFileName);
  const serialized = JSON.stringify(envelope.toJSON ? envelope.toJSON() : envelope, null, 2);

  atomicWriteFileSync(finalFilePath, serialized);
  mirrorAntigravityInboxSync(cleanRecipient, finalFileName, serialized, inboxDir);

  invalidateInboxCache(inboxDir, finalFilePath);

  return {
    messageId: envelope.id,
    path: finalFilePath,
    envelope
  };
}

/**
 * Writes a batch of discrete message envelopes into the recipient's inbox
 * under a single directory CAS advisory lock, maximizing Windows NTFS throughput.
 * 
 * @param {string} recipient - Validated agent name
 * @param {Array<MessageEnvelope|object>} envelopesData - Array of envelopes to write
 * @param {object} [options]
 * @param {number} [options.lockTtlMs] - Custom lock TTL (defaults to dynamic based on batch size)
 * @param {number} [options.timeoutMs=15000] - Lock acquisition timeout
 * @returns {Promise<Array<{ messageId: string, path: string, envelope: MessageEnvelope }>>}
 */
async function writeMessagesBatch(recipient, envelopesData, options = {}) {
  const cleanRecipient = validateAgentName(recipient);
  if (!Array.isArray(envelopesData) || envelopesData.length === 0) {
    return [];
  }

  const meshDir = (options && options.meshDir) || getMeshDir();
  const batchCount = envelopesData.length;
  const lockTtlMs = options.lockTtlMs || Math.max(5000, batchCount * 50);
  const timeoutMs = options.timeoutMs || 15000;

  return await withLock(cleanRecipient, async () => {
    const inboxDir = getInboxDir(cleanRecipient, meshDir);
    const results = [];
    const now = Date.now();

    const prepared = envelopesData.map((data, idx) => {
      const envelope = normalizeEnvelope(cleanRecipient, data);
      envelope.epochMs = (envelope.epochMs || now) + idx;
      return envelope;
    });

    for (let i = 0; i < prepared.length; i++) {
      const envelope = prepared[i];
      const finalFileName = `${envelope.epochMs}_${envelope.id}.json`;
      const finalFilePath = path.join(inboxDir, finalFileName);
      const serialized = JSON.stringify(envelope.toJSON ? envelope.toJSON() : envelope, null, 2);

      await atomicWriteFile(finalFilePath, serialized);
      await mirrorAntigravityInbox(cleanRecipient, finalFileName, serialized, inboxDir);
      fileEnvelopeCache.delete(finalFilePath);

      results.push({
        messageId: envelope.id,
        path: finalFilePath,
        envelope
      });
    }

    inboxDirCache.delete(inboxDir);
    return results;
  }, { ttlMs: lockTtlMs, timeoutMs, meshDir });
}

/**
 * Synchronous variant of writeMessagesBatch
 * @param {string} recipient 
 * @param {Array<MessageEnvelope|object>} envelopesData 
 * @param {object} [options]
 * @returns {Array<{ messageId: string, path: string, envelope: MessageEnvelope }>}
 */
function writeMessagesBatchSync(recipient, envelopesData, options = {}) {
  const cleanRecipient = validateAgentName(recipient);
  if (!Array.isArray(envelopesData) || envelopesData.length === 0) {
    return [];
  }

  const meshDir = (options && options.meshDir) || getMeshDir();
  const batchCount = envelopesData.length;
  const lockTtlMs = options.lockTtlMs || Math.max(5000, batchCount * 50);
  const timeoutMs = options.timeoutMs || 15000;

  return withLockSync(cleanRecipient, () => {
    const inboxDir = getInboxDir(cleanRecipient, meshDir);
    const results = [];
    const now = Date.now();

    const prepared = envelopesData.map((data, idx) => {
      const envelope = normalizeEnvelope(cleanRecipient, data);
      envelope.epochMs = (envelope.epochMs || now) + idx;
      return envelope;
    });

    for (let i = 0; i < prepared.length; i++) {
      const envelope = prepared[i];
      const finalFileName = `${envelope.epochMs}_${envelope.id}.json`;
      const finalFilePath = path.join(inboxDir, finalFileName);
      const serialized = JSON.stringify(envelope.toJSON ? envelope.toJSON() : envelope, null, 2);

      atomicWriteFileSync(finalFilePath, serialized);
      mirrorAntigravityInboxSync(cleanRecipient, finalFileName, serialized, inboxDir);
      fileEnvelopeCache.delete(finalFilePath);

      results.push({
        messageId: envelope.id,
        path: finalFilePath,
        envelope
      });
    }

    inboxDirCache.delete(inboxDir);
    return results;
  }, { ttlMs: lockTtlMs, timeoutMs, meshDir });
}

/**
 * Atomically updates a discrete inbox envelope matching msgId under mailbox CAS lock.
 * Invalidates both fileEnvelopeCache and inboxDirCache.
 * @param {string} agentName
 * @param {string} msgId
 * @param {(msg: object) => object} updaterFn
 * @param {object} [options]
 * @returns {object|null}
 */
function updateDiscreteEnvelopeSync(agentName, msgId, updaterFn, options = {}) {
  const cleanRecipient = validateAgentName(agentName);
  const meshDir = (options && options.meshDir) || getMeshDir();
  const inboxDir = path.join(meshDir, 'inbox', cleanRecipient);
  if (!fs.existsSync(inboxDir)) return null;

  const targetId = String(msgId);
  return withLockSync(cleanRecipient, () => {
    if (!fs.existsSync(inboxDir)) return null;
    const files = retryNtfsOperationSync(() => fs.readdirSync(inboxDir));

    for (const f of files) {
      if (f.startsWith('.tmp') || f.endsWith('.tmp') || !f.endsWith('.json')) continue;
      const fullPath = path.join(inboxDir, f);
      try {
        const raw = retryNtfsOperationSync(() => fs.readFileSync(fullPath, 'utf8'));
        const parsed = JSON.parse(raw);
        if (parsed && String(parsed.id) === targetId) {
          const updated = updaterFn(parsed);
          atomicWriteFileSync(fullPath, JSON.stringify(updated, null, 2));
          invalidateInboxCache(inboxDir, fullPath);
          return updated;
        }
      } catch {}
    }
    return null;
  }, { meshDir });
}

/**
 * Migrates a legacy monolithic mailbox file (mesh/<agent>.json) to discrete message files
 * @param {string} agentName 
 * @returns {number} count of migrated messages
 */
function migrateLegacyMailboxSync(agentName) {
  const clean = sanitizeAgentName(agentName);
  const legacyFile = getInboxFile(clean);
  if (!fs.existsSync(legacyFile)) return 0;

  let count = 0;
  try {
    const content = fs.readFileSync(legacyFile, 'utf8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      for (const item of parsed) {
        const env = MessageEnvelope.create({
          sender: item.from || 'legacy',
          recipient: clean,
          type: 'task_dispatch',
          payload: { message: item.message || '' },
          timestamp: item.timestamp || new Date().toISOString()
        });
        writeMessageSync(clean, env);
        count++;
      }
    }
    fs.unlinkSync(legacyFile);
  } catch {}
  return count;
}

/**
 * Checks if a message envelope is expired based on ttl or expiresAt
 * @param {object} msg 
 * @param {number} [now=Date.now()] 
 * @returns {boolean}
 */
function isEnvelopeExpired(msg, now = Date.now()) {
  if (!msg) return false;
  if (typeof msg.isExpired === 'function') return msg.isExpired(now);
  if (typeof msg.ttl === 'number' && msg.epochMs) {
    if (now > msg.epochMs + msg.ttl) return true;
  }
  if (msg.expiresAt) {
    const expMs = typeof msg.expiresAt === 'number' ? msg.expiresAt : Date.parse(msg.expiresAt);
    if (expMs && now > expMs) return true;
  }
  return false;
}

/**
 * Prunes expired messages from an inbox directory and optionally forwards them to DLQ
 * @param {string} inboxDir 
 * @param {string} [dlqDir=null] 
 * @returns {{ active: object[], pruned: object[] }}
 */
function pruneExpiredInbox(inboxDir, dlqDir = null) {
  if (!fs.existsSync(inboxDir)) return { active: [], pruned: [] };

  const files = retryNtfsOperationSync(() => fs.readdirSync(inboxDir))
    .filter((f) => f.endsWith('.json') && !f.startsWith('.tmp'));
  const now = Date.now();
  const active = [];
  const pruned = [];
  let changed = false;

  for (const f of files) {
    const filePath = path.join(inboxDir, f);
    try {
      const msg = JSON.parse(retryNtfsOperationSync(() => fs.readFileSync(filePath, 'utf8')));
      if (isEnvelopeExpired(msg, now)) {
        if (dlqDir) {
          if (!fs.existsSync(dlqDir)) fs.mkdirSync(dlqDir, { recursive: true });
          msg.deadLetterReason = 'EXPIRED_TTL';
          atomicWriteFileSync(path.join(dlqDir, `expired_${f}`), JSON.stringify(msg, null, 2));
        }
        try {
          retryNtfsOperationSync(() => fs.unlinkSync(filePath));
          fileEnvelopeCache.delete(filePath);
          changed = true;
        } catch {}
        pruned.push(msg);
      } else {
        active.push(msg);
      }
    } catch {}
  }

  if (changed) {
    inboxDirCache.delete(inboxDir);
  }

  return { active, pruned };
}

/**
 * Compacts and prunes empty/dead ephemeral mailboxes and orphaned temporary files in mesh/inbox/
 * @param {object} options
 * @param {boolean} [options.dryRun=false] - If true, calculates actions without modifying files
 * @param {boolean} [options.pruneEmpty=true] - Remove empty mailbox directories
 * @param {boolean} [options.removeEmpty] - Alias for pruneEmpty
 * @param {boolean} [options.pruneTemp=true] - Remove orphaned .tmp files older than tempTtlMs
 * @param {number} [options.tempTtlMs=60000] - Age threshold for orphaned .tmp files (default 60s)
 * @param {string} [options.targetMailbox] - Specific mailbox to compact, or null for all
 * @returns {Promise<{
 *   examined: number,
 *   prunedDirs: number,
 *   prunedEmptyMailboxes: string[],
 *   prunedTempFiles: number,
 *   reclaimedBytes: number,
 *   skippedLocked: string[],
 *   dryRun: boolean
 * }>}
 */
async function compactMailboxes(options = {}) {
  const dryRun = options.dryRun === true;
  const pruneEmpty = options.removeEmpty !== undefined ? Boolean(options.removeEmpty) : (options.pruneEmpty !== false);
  const pruneTemp = options.pruneTemp !== false;
  const tempTtlMs = options.tempTtlMs ?? 60000;
  const targetMailbox = options.targetMailbox ? validateAgentName(options.targetMailbox) : null;
  const meshDir = options.meshDir || getMeshDir();

  const inboxBase = path.join(meshDir, 'inbox');
  const locksDir = path.join(meshDir, 'locks');
  const dlqDir = path.join(meshDir, 'dlq');
  const report = {
    examined: 0,
    prunedDirs: 0,
    prunedEmptyMailboxes: [],
    prunedTempFiles: 0,
    reclaimedBytes: 0,
    skippedLocked: [],
    dryRun
  };

  try {
    await fs.promises.access(inboxBase);
  } catch {
    return report;
  }

  let dirEntries;
  if (targetMailbox) {
    const fullDir = path.join(inboxBase, targetMailbox);
    try {
      const s = await fs.promises.stat(fullDir);
      dirEntries = s.isDirectory() ? [{ name: targetMailbox }] : [];
    } catch {
      dirEntries = [];
    }
  } else {
    try {
      const all = await fs.promises.readdir(inboxBase, { withFileTypes: true });
      dirEntries = all.filter(d => d.isDirectory());
    } catch {
      dirEntries = [];
    }
  }

  const now = Date.now();

  for (const entry of dirEntries) {
    const entryName = entry.name;
    const fullDir = path.join(inboxBase, entryName);
    report.examined++;

    // Safety: Check if mailbox is currently CAS locked
    const lockDir = path.join(locksDir, `${entryName}.lock`);
    const isLocked = await fs.promises.access(lockDir).then(() => true, () => false);
    if (isLocked) {
      report.skippedLocked.push(entryName);
      continue;
    }

    let files;
    try {
      files = await fs.promises.readdir(fullDir);
    } catch {
      continue;
    }

    let activeMessagesCount = 0;
    let prunedTempInMailbox = 0;
    let prunedExpiredInMailbox = 0;
    const messageCandidates = [];

    for (const f of files) {
      if (f.startsWith('.tmp') || f.endsWith('.tmp')) {
        if (pruneTemp) {
          const fullFilePath = path.join(fullDir, f);
          try {
            const fileStat = await fs.promises.stat(fullFilePath);
            if (now - fileStat.mtimeMs > tempTtlMs) {
              report.prunedTempFiles++;
              prunedTempInMailbox++;
              report.reclaimedBytes += fileStat.size;
              if (!dryRun) {
                await retryNtfsOperation(() => fs.promises.unlink(fullFilePath));
                invalidateInboxCache(fullDir, fullFilePath);
              }
            }
          } catch {}
        }
      } else if (/^\d+_[a-zA-Z0-9\-]+\.json$/.test(f)) {
        messageCandidates.push(f);
      }
    }

    if (options.pruneExpired !== false && messageCandidates.length > 0) {
      const BATCH_SIZE = 32;
      for (let i = 0; i < messageCandidates.length; i += BATCH_SIZE) {
        const batch = messageCandidates.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (f) => {
            const fullFilePath = path.join(fullDir, f);
            try {
              const raw = await retryNtfsOperation(() => fs.promises.readFile(fullFilePath, 'utf8'));
              const msg = JSON.parse(raw);
              if (isEnvelopeExpired(msg, now)) {
                if (!dryRun) {
                  await fs.promises.mkdir(dlqDir, { recursive: true });
                  msg.deadLetterReason = 'EXPIRED_TTL';
                  await atomicWriteFile(path.join(dlqDir, `expired_${f}`), JSON.stringify(msg, null, 2));
                  await retryNtfsOperation(() => fs.promises.unlink(fullFilePath));
                  invalidateInboxCache(fullDir, fullFilePath);
                }
                prunedExpiredInMailbox++;
                report.prunedExpired = (report.prunedExpired || 0) + 1;
                return;
              }
            } catch {}
            activeMessagesCount++;
          })
        );
      }
    } else {
      activeMessagesCount += messageCandidates.length;
    }

    // Prune empty mailbox directories if 0 active messages remain
    if (pruneEmpty && activeMessagesCount === 0) {
      const isEmptyNow = dryRun
        ? (files.length - prunedTempInMailbox - prunedExpiredInMailbox === 0)
        : true;
      if (isEmptyNow) {
        if (!dryRun) {
          let remainingFiles = [];
          try {
            remainingFiles = await fs.promises.readdir(fullDir);
          } catch {}

          if (remainingFiles.length === 0) {
            report.prunedEmptyMailboxes.push(entryName);
            try {
              await retryNtfsOperation(() => fs.promises.rmdir(fullDir));
              inboxDirCache.delete(fullDir);
            } catch {}
          }
        } else {
          report.prunedEmptyMailboxes.push(entryName);
        }
      }
    }
  }

  report.prunedDirs = report.prunedEmptyMailboxes.length;
  return report;
}

/**
 * Synchronous variant of readInbox with discrete priority & legacy file fallback
 * @param {string} recipient 
 * @param {object} [options={}]
 * @returns {Array<MessageEnvelope|object>}
 */
function readInboxSync(recipient, options = {}) {
  const cleanRecipient = validateAgentName(recipient);
  const meshDir = (options && options.meshDir) || getMeshDir();
  const inboxDir = path.join(meshDir, 'inbox', cleanRecipient);
  const envelopes = [];
  const limit = (options && typeof options.limit === 'number') ? options.limit : null;
  const resolvedOrder = (options && options.order) || ((options && options.newestFirst) ? 'desc' : 'asc');

  if (fs.existsSync(inboxDir)) {
    try {
      const dirStat = fs.statSync(inboxDir);
      const dirCached = inboxDirCache.get(inboxDir);
      let cacheHandled = false;

      if (dirCached && dirCached.mtimeMs === dirStat.mtimeMs) {
        if (dirCached.allLoaded) {
          const list = resolvedOrder === 'desc' ? dirCached.allDesc : dirCached.allAsc;
          const sliced = limit !== null ? list.slice(0, limit) : list;
          envelopes.push(...sliced.map(cloneEnvelope));
          cacheHandled = true;
        } else if (dirCached.limit !== null && limit !== null && dirCached.limit >= limit && dirCached.order === resolvedOrder) {
          envelopes.push(...dirCached.envelopes.slice(0, limit).map(cloneEnvelope));
          cacheHandled = true;
        }
      }

      if (!cacheHandled) {
        const files = retryNtfsOperationSync(() => fs.readdirSync(inboxDir));
        const parsedFiles = [];
        for (const f of files) {
          if (!/^\d+_[a-zA-Z0-9\-]+\.json$/.test(f)) continue;
          const sepIdx = f.indexOf('_');
          parsedFiles.push({
            file: f,
            ts: parseInt(f.slice(0, sepIdx), 10) || 0,
            idPart: f.slice(sepIdx + 1, -5)
          });
        }

        parsedFiles.sort((a, b) => {
          if (a.ts !== b.ts) return a.ts - b.ts;
          return a.idPart.localeCompare(b.idPart);
        });

        const messageFiles = parsedFiles.map(p => p.file);
        const allLoaded = limit === null || messageFiles.length <= limit;
        let targetFiles = messageFiles;

        if (!allLoaded) {
          targetFiles = resolvedOrder === 'desc'
            ? messageFiles.slice(-limit)
            : messageFiles.slice(0, limit);
        }

        const loadedEnvelopes = [];
        for (const file of targetFiles) {
          const fullPath = path.join(inboxDir, file);
          try {
            const fileStat = fs.statSync(fullPath);
            const cachedFile = fileEnvelopeCache.get(fullPath);
            if (cachedFile && cachedFile.mtimeMs === fileStat.mtimeMs) {
              loadedEnvelopes.push(cachedFile.envelope);
            } else {
              const content = retryNtfsOperationSync(() => fs.readFileSync(fullPath, 'utf8'));
              const parsed = JSON.parse(content);
              const env = freezeEnvelopeDeep(buildEnvelopeFromParsed(parsed));
              fileEnvelopeCache.set(fullPath, { mtimeMs: fileStat.mtimeMs, envelope: env });
              loadedEnvelopes.push(env);
            }
          } catch {
            continue;
          }
        }

        if (allLoaded) {
          const allAsc = loadedEnvelopes;
          const allDesc = [...loadedEnvelopes].reverse();
          inboxDirCache.set(inboxDir, {
            mtimeMs: dirStat.mtimeMs,
            allLoaded: true,
            allAsc,
            allDesc
          });
          const list = resolvedOrder === 'desc' ? allDesc : allAsc;
          const sliced = limit !== null ? list.slice(0, limit) : list;
          envelopes.push(...sliced.map(cloneEnvelope));
        } else {
          if (resolvedOrder === 'desc') {
            loadedEnvelopes.reverse();
          }
          inboxDirCache.set(inboxDir, {
            mtimeMs: dirStat.mtimeMs,
            allLoaded: false,
            limit,
            order: resolvedOrder,
            envelopes: loadedEnvelopes
          });
          envelopes.push(...loadedEnvelopes.map(cloneEnvelope));
        }
      }
    } catch {}
  }

  // If no discrete messages found, check legacy file (mesh/<recipient>.json)
  if (envelopes.length === 0) {
    const legacyFile = getInboxFile(cleanRecipient, meshDir);
    if (fs.existsSync(legacyFile)) {
      try {
        const content = fs.readFileSync(legacyFile, 'utf8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          return limit !== null ? parsed.slice(0, limit) : parsed;
        }
      } catch {}
    }
  }

  return envelopes;
}

function makeThenableArray(arr) {
  Object.defineProperty(arr, 'then', {
    value: function(onFulfilled, onRejected) {
      return Promise.resolve([...this]).then(onFulfilled, onRejected);
    },
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.defineProperty(arr, 'catch', {
    value: function(onRejected) {
      return Promise.resolve([...this]).catch(onRejected);
    },
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.defineProperty(arr, 'finally', {
    value: function(onFinally) {
      return Promise.resolve([...this]).finally(onFinally);
    },
    enumerable: false,
    configurable: true,
    writable: true
  });
  return arr;
}

/**
 * Reads all discrete message envelopes from an agent's inbox sorted chronologically
 * Returns a dual Array-Promise: supports sync Array methods and awaitable Promise without V8 deadlock
 * @param {string} recipient 
 * @param {object} options 
 * @returns {Promise<MessageEnvelope[]> & MessageEnvelope[]}
 */
function readInbox(recipient, options = {}) {
  const syncArr = readInboxSync(recipient, options);
  return makeThenableArray(syncArr);
}

/**
 * Acknowledges a discrete message by moving it to archive or unlinking
 * @param {string} agentName 
 * @param {string} messageId 
 * @param {object} options { unlink: boolean }
 * @returns {Promise<boolean>}
 */
async function ackMessage(agentName, messageId, options = {}) {
  const cleanRecipient = validateAgentName(agentName);
  if (typeof messageId !== 'string' || !messageId.trim()) return false;
  const targetId = messageId.trim();
  const meshDir = (options && options.meshDir) || getMeshDir();
  const inboxDir = getInboxDir(cleanRecipient, meshDir);

  if (!fs.existsSync(inboxDir)) return false;

  const files = await retryNtfsOperation(() => fs.promises.readdir(inboxDir));

  const targetFile = files.find((f) => {
    if (f.startsWith('.tmp') || f.endsWith('.tmp') || !f.endsWith('.json')) return false;
    if (!/^\d+_/.test(f)) return false;
    const sepIdx = f.indexOf('_');
    return f.slice(sepIdx + 1, -5) === targetId;
  });
  if (!targetFile) return false;

  const srcPath = path.join(inboxDir, targetFile);

  if (options.unlink === true) {
    await retryNtfsOperation(async () => {
      if (fs.existsSync(srcPath)) {
        await fs.promises.unlink(srcPath);
      }
    });
    invalidateInboxCache(inboxDir, srcPath);
    return true;
  }

  // Move to archive/<date>/<agentName>/<targetFile>
  const today = new Date().toISOString().slice(0, 10);
  const archiveDir = path.join(meshDir, 'archive', today, cleanRecipient);
  await fs.promises.mkdir(archiveDir, { recursive: true });
  const destPath = path.join(archiveDir, targetFile);

  await retryNtfsOperation(() => fs.promises.rename(srcPath, destPath));

  invalidateInboxCache(inboxDir, srcPath);
  return true;
}

// ============================================================================
// Deadlock-Free Compare-And-Swap (CAS) Directory Advisory Locking
// ============================================================================

function normalizeLockArgs(ttlMsOrOpts, options) {
  let ttlMs = 3000;
  let opts = options || {};
  if (ttlMsOrOpts && typeof ttlMsOrOpts === 'object') {
    opts = ttlMsOrOpts;
    ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 3000;
  } else if (Number.isFinite(ttlMsOrOpts)) {
    ttlMs = ttlMsOrOpts;
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10000;
  const meshDir = opts.meshDir || getMeshDir();
  return { ttlMs, timeoutMs, meshDir };
}

function evaluateLockStale(metaRaw, dirStat, ttlMs) {
  if (metaRaw !== null) {
    const meta = JSON.parse(metaRaw);
    const age = Date.now() - meta.createdAt;
    const effectiveTtl = meta.ttlMs || ttlMs;
    if (age > effectiveTtl) {
      return true;
    }
    if (meta.ownerPid && meta.ownerPid !== process.pid) {
      try {
        process.kill(meta.ownerPid, 0);
      } catch (killErr) {
        if (killErr.code === 'ESRCH') {
          return true;
        }
      }
    }
    return false;
  }

  // Empty or broken lock dir lacking metadata.json: fixed short grace window
  const graceMs = Math.min(1000, Math.max(250, ttlMs));
  const dirAge = Date.now() - (dirStat.mtimeMs || dirStat.birthtimeMs || 0);
  return dirAge > graceMs;
}

function createLockMetadata(cleanName, ttlMs, token) {
  return JSON.stringify({
    ownerPid: process.pid,
    createdAt: Date.now(),
    ttlMs,
    resourceName: cleanName,
    token
  }, null, 2);
}

/**
 * Deadlock-Free Compare-And-Swap (CAS) Directory Advisory Locking
 * @param {string} resourceName 
 * @param {number|object} [ttlMs=3000] Default 3000ms (or options object)
 * @param {object} [options={}] { timeoutMs: 10000, meshDir }
 * @returns {Promise<{ lockDir: string, resourceName: string, token: string, ownerPid: number }>}
 */
async function acquireLock(resourceName, ttlMsOrOpts = 3000, options = {}) {
  const { ttlMs, timeoutMs, meshDir } = normalizeLockArgs(ttlMsOrOpts, options);
  const cleanName = sanitizeAgentName(resourceName);
  const locksDir = path.join(meshDir, 'locks');
  await fs.promises.mkdir(locksDir, { recursive: true });

  const lockDir = path.join(locksDir, `${cleanName}.lock`);
  const metaFile = path.join(lockDir, 'metadata.json');
  const startTime = Date.now();
  const token = crypto.randomUUID();
  let cachedMeta = null;
  let lastMetaCheckMs = 0;

  while (Date.now() - startTime < timeoutMs) {
    try {
      await fs.promises.mkdir(lockDir);
      try {
        await fs.promises.writeFile(metaFile, createLockMetadata(cleanName, ttlMs, token), 'utf8');
      } catch (writeErr) {
        try { await fs.promises.rmdir(lockDir); } catch {}
        throw writeErr;
      }

      return {
        lockDir,
        resourceName: cleanName,
        token,
        ownerPid: process.pid
      };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }

      let isStale = false;
      const now = Date.now();
      try {
        if (cachedMeta && (now - lastMetaCheckMs < 100)) {
          const age = now - cachedMeta.createdAt;
          const effectiveTtl = cachedMeta.ttlMs || ttlMs;
          if (age > effectiveTtl) {
            isStale = true;
          } else if (cachedMeta.ownerPid && cachedMeta.ownerPid !== process.pid) {
            try {
              process.kill(cachedMeta.ownerPid, 0);
            } catch (killErr) {
              if (killErr.code === 'ESRCH') isStale = true;
            }
          }
        } else {
          let metaRaw = null;
          try {
            metaRaw = await fs.promises.readFile(metaFile, 'utf8');
            lastMetaCheckMs = now;
            try { cachedMeta = JSON.parse(metaRaw); } catch { cachedMeta = null; }
          } catch (readErr) {
            if (readErr.code !== 'ENOENT') throw readErr;
            cachedMeta = null;
          }
          const dirStat = metaRaw === null ? await fs.promises.stat(lockDir) : null;
          isStale = evaluateLockStale(metaRaw, dirStat, ttlMs);
        }
      } catch {
        cachedMeta = null;
      }

      if (isStale) {
        cachedMeta = null;
        lastMetaCheckMs = 0;
        const stalePurgeDir = `${lockDir}.stale.${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
        try {
          await fs.promises.rename(lockDir, stalePurgeDir);
          try { await fs.promises.unlink(path.join(stalePurgeDir, 'metadata.json')); } catch {}
          try { await fs.promises.rmdir(stalePurgeDir); } catch {}
        } catch {}
        continue;
      }

      const jitter = Math.floor(Math.random() * 25) + 15;
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }

  throw new LockTimeoutError(`Lock acquisition timed out after ${timeoutMs}ms for resource "${resourceName}"`);
}

async function verifyLockOwnershipAsync(metaFile, lockDir, token) {
  if (!token) return true;
  try {
    const raw = await fs.promises.readFile(metaFile, 'utf8');
    const meta = JSON.parse(raw);
    return !meta.token || meta.token === token;
  } catch (readErr) {
    if (readErr.code === 'ENOENT') {
      try {
        await fs.promises.access(lockDir);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Releases a CAS advisory lock safely by verifying ownership and atomically renaming
 * the lock directory before unlinking its metadata.
 * @param {object} lockHandle 
 */
async function releaseLock(lockHandle) {
  if (!lockHandle || !lockHandle.lockDir) return;
  const { lockDir, token } = lockHandle;
  const metaFile = path.join(lockDir, 'metadata.json');

  try {
    const owned = await verifyLockOwnershipAsync(metaFile, lockDir, token);
    if (!owned) return;

    const releasingDir = `${lockDir}.releasing.${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
    try {
      await retryNtfsOperation(() => fs.promises.rename(lockDir, releasingDir), 3);
      try {
        await retryNtfsOperation(() => fs.promises.unlink(path.join(releasingDir, 'metadata.json')));
      } catch {}
      try {
        await retryNtfsOperation(() => fs.promises.rmdir(releasingDir));
      } catch {}
      return;
    } catch (renameErr) {
      if (renameErr && renameErr.code === 'ENOENT') return;
      // On Windows NTFS, concurrent contenders reading metadata.json can block dir rename with EPERM/EACCES/EBUSY.
      // Re-verify ownership token strictly before falling back to unlink+rmdir.
      const stillOwned = await verifyLockOwnershipAsync(metaFile, lockDir, token);
      if (!stillOwned) return;
      try {
        await retryNtfsOperation(() => fs.promises.unlink(metaFile));
      } catch {}
      try {
        await retryNtfsOperation(() => fs.promises.rmdir(lockDir));
      } catch {}
    }
  } catch {
    // Lock already removed, stolen, or released
  }
}

/**
 * Synchronous variant of acquireLock
 */
function acquireLockSync(resourceName, ttlMsOrOpts = 3000, options = {}) {
  const { ttlMs, timeoutMs, meshDir } = normalizeLockArgs(ttlMsOrOpts, options);
  const cleanName = sanitizeAgentName(resourceName);
  const locksDir = path.join(meshDir, 'locks');
  if (!fs.existsSync(locksDir)) {
    try { fs.mkdirSync(locksDir, { recursive: true }); } catch {}
  }

  const lockDir = path.join(locksDir, `${cleanName}.lock`);
  const metaFile = path.join(lockDir, 'metadata.json');
  const startTime = Date.now();
  const token = crypto.randomUUID();

  while (Date.now() - startTime < timeoutMs) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(metaFile, createLockMetadata(cleanName, ttlMs, token), 'utf8');
      } catch (writeErr) {
        try { fs.rmdirSync(lockDir); } catch {}
        throw writeErr;
      }
      return {
        lockDir,
        resourceName: cleanName,
        token,
        ownerPid: process.pid
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      let isStale = false;
      try {
        let metaRaw = null;
        if (fs.existsSync(metaFile)) {
          metaRaw = fs.readFileSync(metaFile, 'utf8');
        }
        const dirStat = metaRaw === null ? fs.statSync(lockDir) : null;
        isStale = evaluateLockStale(metaRaw, dirStat, ttlMs);
      } catch {}

      if (isStale) {
        const stalePurgeDir = `${lockDir}.stale.${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
        try {
          fs.renameSync(lockDir, stalePurgeDir);
          const purgeMeta = path.join(stalePurgeDir, 'metadata.json');
          if (fs.existsSync(purgeMeta)) fs.unlinkSync(purgeMeta);
          fs.rmdirSync(stalePurgeDir);
        } catch {}
        continue;
      }

      const jitter = Math.floor(Math.random() * 25) + 15;
      sleepSyncSafe(jitter);
    }
  }

  throw new LockTimeoutError(`Sync lock acquisition timed out after ${timeoutMs}ms for resource "${resourceName}"`);
}

function verifyLockOwnershipSync(metaFile, lockDir, token) {
  if (!token) return true;
  if (!fs.existsSync(metaFile)) {
    return fs.existsSync(lockDir);
  }
  try {
    const raw = fs.readFileSync(metaFile, 'utf8');
    const meta = JSON.parse(raw);
    return !meta.token || meta.token === token;
  } catch {
    return false;
  }
}

/**
 * Synchronous variant of releaseLock
 */
function releaseLockSync(lockHandle) {
  if (!lockHandle || !lockHandle.lockDir) return;
  const { lockDir, token } = lockHandle;
  if (!fs.existsSync(lockDir)) return;

  const metaFile = path.join(lockDir, 'metadata.json');
  try {
    if (!verifyLockOwnershipSync(metaFile, lockDir, token)) return;

    const releasingDir = `${lockDir}.releasing.${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
    try {
      retryNtfsOperationSync(() => fs.renameSync(lockDir, releasingDir), 3);
      try {
        const relMeta = path.join(releasingDir, 'metadata.json');
        if (fs.existsSync(relMeta)) {
          retryNtfsOperationSync(() => fs.unlinkSync(relMeta));
        }
      } catch {}
      try {
        retryNtfsOperationSync(() => fs.rmdirSync(releasingDir));
      } catch {}
      return;
    } catch (renameErr) {
      if (renameErr && renameErr.code === 'ENOENT') return;
      if (!verifyLockOwnershipSync(metaFile, lockDir, token)) return;
      try {
        if (fs.existsSync(metaFile)) {
          retryNtfsOperationSync(() => fs.unlinkSync(metaFile));
        }
      } catch {}
      try {
        retryNtfsOperationSync(() => fs.rmdirSync(lockDir));
      } catch {}
    }
  } catch {}
}

/**
 * Executes a function within the scope of a CAS advisory lock
 * @param {string} resourceName 
 * @param {Function} fn 
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function withLock(resourceName, fn, options = {}) {
  const ttlMs = options.ttlMs || 5000;
  const lockHandle = await acquireLock(resourceName, ttlMs, options);
  try {
    return await fn(lockHandle);
  } finally {
    await releaseLock(lockHandle);
  }
}

/**
 * Executes a function within the scope of a synchronous CAS advisory lock
 * @param {string} resourceName 
 * @param {Function} fn 
 * @param {object} [options]
 * @returns {any}
 */
function withLockSync(resourceName, fn, options = {}) {
  const ttlMs = options.ttlMs || 5000;
  const lockHandle = acquireLockSync(resourceName, ttlMs, options);
  try {
    return fn(lockHandle);
  } finally {
    releaseLockSync(lockHandle);
  }
}

/**
 * Reactive inbox wait for incoming messages using file watching and timeout
 * @param {string} agentName 
 * @param {number} timeoutMs Default 30000ms
 * @returns {Promise<MessageEnvelope[]>}
 */
async function waitForUnread(agentName, timeoutMs = 30000) {
  const cleanRecipient = validateAgentName(agentName);
  const inboxDir = getInboxDir(cleanRecipient);

  // Check immediately
  const initial = await readInbox(cleanRecipient);
  if (initial.length > 0) return initial;

  return new Promise((resolve) => {
    let watcher = null;
    let timer = null;
    let pollInterval = null;
    let resolved = false;
    let checking = false;
    let pendingCheck = false;
    let lastMtimeMs = 0;

    try {
      lastMtimeMs = fs.statSync(inboxDir).mtimeMs;
    } catch {}

    const cleanup = () => {
      resolved = true;
      if (timer) clearTimeout(timer);
      if (pollInterval) clearInterval(pollInterval);
      if (watcher) {
        try { watcher.close(); } catch {}
        watcher = null;
      }
    };

    const check = async (forceInvalidate = false) => {
      if (resolved) return;
      if (checking) {
        pendingCheck = pendingCheck || forceInvalidate;
        return;
      }
      checking = true;
      try {
        if (forceInvalidate) {
          inboxDirCache.delete(inboxDir);
        } else {
          try {
            const st = await fs.promises.stat(inboxDir);
            if (st.mtimeMs !== lastMtimeMs) {
              lastMtimeMs = st.mtimeMs;
              inboxDirCache.delete(inboxDir);
            }
          } catch {
            inboxDirCache.delete(inboxDir);
          }
        }

        const msgs = await readInbox(cleanRecipient);
        if (!resolved && msgs.length > 0) {
          cleanup();
          resolve(msgs);
          return;
        }
      } catch {
        // Ignore transient watch/read errors while waiting
      } finally {
        checking = false;
      }

      if (!resolved && pendingCheck) {
        pendingCheck = false;
        check(true);
      }
    };

    try {
      watcher = fs.watch(inboxDir, () => {
        check(true);
      });
      watcher.on('error', () => {
        if (watcher) {
          try { watcher.close(); } catch {}
          watcher = null;
        }
      });
    } catch {
      watcher = null;
    }

    // Backup polling check every 250ms in case fs.watch events are dropped
    pollInterval = setInterval(() => check(false), 250);

    timer = setTimeout(() => {
      cleanup();
      resolve([]);
    }, timeoutMs);
  });
}

/**
 * Synchronously clears an agent's inbox
 * @param {string} agentName 
 * @returns {number} count of removed messages
 */
function clearInboxSync(agentName) {
  const cleanRecipient = validateAgentName(agentName);
  const meshDir = getMeshDir();
  const inboxDir = getInboxDir(cleanRecipient, meshDir);
  let count = 0;

  if (fs.existsSync(inboxDir)) {
    try {
      const files = retryNtfsOperationSync(() => fs.readdirSync(inboxDir));
      for (const f of files) {
        if (f.endsWith('.json') || f.endsWith('.tmp')) {
          const fullPath = path.join(inboxDir, f);
          try {
            retryNtfsOperationSync(() => fs.unlinkSync(fullPath));
            fileEnvelopeCache.delete(fullPath);
            count++;
          } catch {}
        }
      }
    } catch {}
  }

  // Also clear legacy file if present
  const legacyFile = getInboxFile(cleanRecipient, meshDir);
  if (fs.existsSync(legacyFile)) {
    try {
      fs.unlinkSync(legacyFile);
      count++;
    } catch {}
  }

  inboxDirCache.delete(inboxDir);

  return count;
}

/**
 * Clears an agent's inbox
 * @param {string} agentName 
 * @returns {Promise<number>} count of removed messages
 */
async function clearInbox(agentName) {
  return clearInboxSync(agentName);
}

/**
 * Lists all active mailboxes and message counts
 * @returns {Promise<Array<{ name: string, total: number, unread: number }>>}
 */
const EPHEMERAL_MAILBOX_REGEX = /^(?:(?:test|worker|stress|wake|ephem|fuzz|dry[-_]agent|tmp|agent|alpha|architect|beta|coordinator|reviewer|challenger|auditor|discrete|tui[-_]churn|target_agent|locktest|a2a[-_]http|cron|benchmark|subagent|batch|brand|ended|epipe|burst|chrono|adv|sse|resilience|interrupt|mtime|locked|fallback|merge|offline|online|simulated|tester|explorer|executor|subworker|unit|recursion|crash|mimo|external_daemon|orchestrator|peer|task[-_]unit)[_-])|^(?:test|worker|fuzz|ephem|tester|\d+)$|[_-]\d{8,}$|[_-][0-9a-f]{5,}$/i;

function isEphemeralMailboxName(name) {
  return EPHEMERAL_MAILBOX_REGEX.test(String(name || ''));
}

async function listActiveMailboxes(options = {}) {
  const excludeEphemeral = Boolean(options && options.excludeEphemeral);
  const meshDir = (options && options.meshDir) || getMeshDir();
  const inboxBase = path.join(meshDir, 'inbox');
  const mailboxes = [];
  const seen = new Set();

  if (fs.existsSync(inboxBase)) {
    try {
      const entries = await fs.promises.readdir(inboxBase, { withFileTypes: true });
      const dirEntries = entries.filter((entry) => {
        if (!entry.isDirectory()) return false;
        if (excludeEphemeral && isEphemeralMailboxName(entry.name)) return false;
        return true;
      });

      const BATCH_SIZE = 48;
      for (let i = 0; i < dirEntries.length; i += BATCH_SIZE) {
        const batch = dirEntries.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (entry) => {
            try {
              const files = await fs.promises.readdir(path.join(inboxBase, entry.name));
              let msgCount = 0;
              for (const f of files) {
                if (/^\d+_[a-zA-Z0-9\-]+\.json$/.test(f)) msgCount++;
              }
              return { name: entry.name, total: msgCount, unread: msgCount };
            } catch {
              return null;
            }
          })
        );
        for (const item of batchResults) {
          if (item) {
            mailboxes.push(item);
            seen.add(item.name);
          }
        }
      }
    } catch {}
  }

  // Also check legacy mesh/*.json files
  if (fs.existsSync(meshDir)) {
    try {
      const rootFiles = await fs.promises.readdir(meshDir);
      for (const rf of rootFiles) {
        if (rf.endsWith('.json') && rf !== 'dlq.json' && rf !== 'daemon.pid') {
          const name = rf.replace('.json', '');
          if (excludeEphemeral && isEphemeralMailboxName(name)) continue;
          if (!seen.has(name)) {
            try {
              const content = JSON.parse(await fs.promises.readFile(path.join(meshDir, rf), 'utf8'));
              mailboxes.push({
                name,
                total: Array.isArray(content) ? content.length : 1,
                unread: Array.isArray(content) ? content.filter(m => !m.read).length : 0
              });
              seen.add(name);
            } catch {}
          }
        }
      }
    } catch {}
  }

  return mailboxes;
}

// --- Backwards Compatibility Legacy Helpers ---
function sanitizeName(name) {
  if (typeof name !== 'string') return 'unknown';
  const base = path.basename(name.replace(/\0/g, '').replace(/\\/g, '/'));
  let clean = base.replace(/[^a-zA-Z0-9_\-#.]/g, '_').replace(/^\.+/, '');
  if (!clean) return 'unknown';
  if (DOS_DEVICE_REGEX.test(clean)) {
    clean = `safe_${clean}`;
  }
  return clean;
}

function safeWriteJson(targetPath, data) {
  atomicWriteFileSync(targetPath, JSON.stringify(data, null, 2));
}

function getInboxFile(agentName, meshDir = getMeshDir()) {
  const raw = (agentName || 'unknown').toString().toLowerCase().trim();
  const resolvedMeshDir = path.resolve(meshDir);
  if (raw.includes('#')) {
    const parts = raw.split('#');
    const agent = sanitizeName(parts[0]);
    const session = sanitizeName(parts.slice(1).join('-'));
    return path.join(resolvedMeshDir, `${agent}-${session}.json`);
  }
  const clean = sanitizeName(raw);
  return path.join(resolvedMeshDir, `${clean}.json`);
}

function getChannelFile(channelName, meshDir = getMeshDir()) {
  const clean = sanitizeName((channelName || '').replace(/^#/, ''));
  const channelsDir = path.join(meshDir, 'channels');
  if (!fs.existsSync(channelsDir)) {
    try { fs.mkdirSync(channelsDir, { recursive: true }); } catch {}
  }
  const resolvedDir = path.resolve(channelsDir);
  return path.join(resolvedDir, `${clean}.json`);
}

function writeInbox(agentName, messages) {
  const clean = sanitizeName(agentName);
  const meshDir = getMeshDir();
  const target = getInboxFile(clean, meshDir);
  safeWriteJson(target, messages);
  const inboxDir = path.join(meshDir, 'inbox', clean);
  inboxDirCache.delete(inboxDir);
}

function checkAndMarkRead(agentName) {
  const clean = sanitizeName(agentName);
  const file = getInboxFile(clean);
  if (!fs.existsSync(file)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    const unread = list.filter(m => !m.read);
    if (unread.length > 0) {
      list.forEach(m => (m.read = true));
      safeWriteJson(file, list);
    }
    return unread;
  } catch {
    return [];
  }
}

function sendChannelMessage(channelName, from, message) {
  const normChannel = '#' + (channelName || 'general').replace(/^#/, '');
  const clean = sanitizeName(normChannel.replace(/^#/, ''));
  const file = getChannelFile(clean);

  return withLockSync(`channel_${clean}`, () => {
    let history = [];
    if (fs.existsSync(file)) {
      try {
        const raw = retryNtfsOperationSync(() => fs.readFileSync(file, 'utf8'));
        history = JSON.parse(raw);
        if (!Array.isArray(history)) history = [];
      } catch {
        history = [];
      }
    }

    const msgObj = {
      id: `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      from: from || 'operator',
      channel: normChannel,
      message,
      timestamp: new Date().toISOString()
    };

    history.push(msgObj);
    atomicWriteFileSync(file, JSON.stringify(history, null, 2));

    return msgObj;
  }, { ttlMs: 3000, timeoutMs: 10000 });
}

function readChannel(channelName) {
  const clean = sanitizeName((channelName || 'general').replace(/^#/, ''));
  const file = getChannelFile(clean);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = retryNtfsOperationSync(() => fs.readFileSync(file, 'utf8'));
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function clearChannel(channelName) {
  const clean = sanitizeName((channelName || 'general').replace(/^#/, ''));
  const file = getChannelFile(clean);
  if (!fs.existsSync(file)) return true;

  return withLockSync(`channel_${clean}`, () => {
    try {
      retryNtfsOperationSync(() => fs.unlinkSync(file));
      return true;
    } catch {
      return false;
    }
  });
}

function listChannels() {
  const channelsDir = path.join(getMeshDir(), 'channels');
  if (!fs.existsSync(channelsDir)) return [];
  try {
    const files = fs.readdirSync(channelsDir);
    return files.filter(f => f.endsWith('.json') && !f.startsWith('.tmp_')).map(f => {
      const name = '#' + f.replace('.json', '');
      try {
        const content = JSON.parse(fs.readFileSync(path.join(channelsDir, f), 'utf8'));
        return { name, total: Array.isArray(content) ? content.length : 0, messages: content };
      } catch {
        return { name, total: 0, messages: [] };
      }
    });
  } catch {
    return [];
  }
}

async function broadcastToAgents(from, targets, message, customDispatcher) {
  let targetList = [];
  if (targets === 'all') {
    const mailboxes = await listActiveMailboxes();
    targetList = mailboxes.map(m => m.name);
  } else if (typeof targets === 'string') {
    targetList = targets.split(',').map(t => t.trim()).filter(Boolean);
  } else if (Array.isArray(targets)) {
    targetList = targets;
  }

  const results = [];
  for (const t of targetList) {
    if (typeof customDispatcher === 'function') {
      results.push(customDispatcher(from, t, message));
    } else {
      const env = MessageEnvelope.create({
        sender: from,
        recipient: t,
        type: 'task_dispatch',
        payload: { message }
      });
      results.push(await writeMessage(t, env));
    }
  }
  return results;
}

// ============================================================================
// #70: Peer Liveness Heartbeat Registry
// ============================================================================

class HeartbeatRegistry {
  constructor(meshDir = getMeshDir()) {
    this.meshDir = meshDir || getMeshDir();
    this.heartbeatDir = path.join(this.meshDir, 'heartbeats');
    if (!fs.existsSync(this.heartbeatDir)) {
      try { fs.mkdirSync(this.heartbeatDir, { recursive: true }); } catch {}
    }
  }

  touchHeartbeat(agent, metadata = {}) {
    const clean = validateAgentName(agent);
    const epochMs = Date.now();
    const record = {
      agent: clean,
      epochMs,
      timestamp: new Date(epochMs).toISOString(),
      pid: metadata.pid || process.pid,
      status: metadata.status || 'online',
      role: metadata.role || 'worker',
      capabilities: metadata.capabilities || []
    };

    const filePath = resolveSafePath(this.heartbeatDir, `${clean}.json`);
    return withLockSync(`heartbeat_${clean}`, () => {
      atomicWriteFileSync(filePath, JSON.stringify(record, null, 2));
      return record;
    }, { meshDir: this.meshDir });
  }

  writeHeartbeat(agent, metadata = {}) {
    return this.touchHeartbeat(agent, metadata);
  }

  getPeerStatus(agent, ttlMs = 30000, options = {}) {
    const clean = validateAgentName(agent);
    const effectiveTtl = ttlMs ?? 30000;
    const filePath = resolveSafePath(this.heartbeatDir, `${clean}.json`);
    if (!fs.existsSync(filePath)) {
      return { status: 'unknown', online: false };
    }

    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const ageMs = Date.now() - record.epochMs;
      let isOnline = ageMs <= effectiveTtl;
      let status = isOnline ? record.status : 'stale';

      if (options.checkPid && isOnline && record.pid) {
        try {
          process.kill(record.pid, 0);
        } catch (e) {
          if (e.code === 'ESRCH') {
            isOnline = false;
            status = 'DEAD_PID';
          }
        }
      }

      return {
        ...record,
        ageMs,
        online: isOnline,
        status
      };
    } catch {
      return { status: 'error', online: false };
    }
  }

  listLivePeers(ttlMs = 30000, options = {}) {
    if (!fs.existsSync(this.heartbeatDir)) return [];
    const files = fs.readdirSync(this.heartbeatDir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp'));
    const live = [];

    for (const f of files) {
      try {
        const agent = f.replace(/\.json$/, '');
        const st = this.getPeerStatus(agent, ttlMs, options);
        if (st.online) {
          live.push(st);
        }
      } catch {
        continue;
      }
    }
    return live;
  }

  evictStalePeers(ttlMs = 60000, options = {}) {
    if (!fs.existsSync(this.heartbeatDir)) return [];
    const effectiveTtl = ttlMs ?? 60000;
    const files = fs.readdirSync(this.heartbeatDir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp'));
    const evicted = [];

    for (const f of files) {
      const filePath = path.join(this.heartbeatDir, f);
      try {
        const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const ageMs = Date.now() - record.epochMs;
        let dead = ageMs > effectiveTtl;

        if (options.checkPid && !dead && record.pid) {
          try {
            process.kill(record.pid, 0);
          } catch (e) {
            if (e.code === 'ESRCH') dead = true;
          }
        }

        if (dead) {
          try { fs.unlinkSync(filePath); } catch {}
          evicted.push(record.agent);
        }
      } catch {}
    }
    return evicted;
  }
}

// ============================================================================
// #66: Zero-Loss Transactional Cross-Agent Handoff
// ============================================================================

const MAX_ACTIVE_HANDOFFS = 500;
const TERMINAL_HANDOFF_STATES = new Set(['COMPLETED', 'REJECTED', 'TIMED_OUT']);

class HandoffCoordinator {
  constructor(meshDir = getMeshDir()) {
    this.meshDir = meshDir || getMeshDir();
    this.handoffsDir = path.join(this.meshDir, 'handoffs');
    if (!fs.existsSync(this.handoffsDir)) {
      try { fs.mkdirSync(this.handoffsDir, { recursive: true }); } catch {}
    }
    this.activeHandoffs = new Map();
  }

  _trackHandoff(cleanId, record) {
    if (TERMINAL_HANDOFF_STATES.has(record.status)) {
      this.activeHandoffs.delete(cleanId);
      return;
    }
    if (this.activeHandoffs.has(cleanId)) {
      this.activeHandoffs.delete(cleanId);
    } else if (this.activeHandoffs.size >= MAX_ACTIVE_HANDOFFS) {
      const oldestKey = this.activeHandoffs.keys().next().value;
      if (oldestKey !== undefined) {
        this.activeHandoffs.delete(oldestKey);
      }
    }
    this.activeHandoffs.set(cleanId, record);
  }

  _readFreshHandoffSync(cleanId) {
    try {
      const handoffPath = resolveSafePath(this.handoffsDir, `${cleanId}.json`);
      if (fs.existsSync(handoffPath)) {
        const raw = retryNtfsOperationSync(() => fs.readFileSync(handoffPath, 'utf8'));
        const parsed = JSON.parse(raw);
        this._trackHandoff(cleanId, parsed);
        return parsed;
      }
    } catch {}
    return null;
  }

  async _writeHandoffAsync(cleanId, record) {
    this._trackHandoff(cleanId, record);
    const handoffPath = resolveSafePath(this.handoffsDir, `${cleanId}.json`);
    await atomicWriteFile(handoffPath, JSON.stringify(record, null, 2));
  }

  async initiateHandoff(senderOrOptions, recipientArg, taskIdArg, contextArg = {}, timeoutMsArg = 5000) {
    let sender, recipient, taskId, context, timeoutMs;
    if (senderOrOptions && typeof senderOrOptions === 'object') {
      sender = senderOrOptions.sender;
      recipient = senderOrOptions.recipient;
      taskId = senderOrOptions.taskId;
      context = senderOrOptions.context || {};
      timeoutMs = senderOrOptions.timeoutMs || 5000;
    } else {
      sender = senderOrOptions;
      recipient = recipientArg;
      taskId = taskIdArg;
      context = contextArg || {};
      timeoutMs = timeoutMsArg || 5000;
    }

    if (!sender || !recipient || !taskId) {
      throw new Error('sender, recipient, and taskId are required for handoff');
    }

    const cleanSender = validateAgentName(sender);
    const cleanRecipient = validateAgentName(recipient);
    const handoffId = `hnd_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();

    const record = {
      handoffId,
      sender: cleanSender,
      recipient: cleanRecipient,
      taskId,
      status: 'INITIATED',
      context,
      timeoutMs,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString()
    };

    await withLock(`handoff_${handoffId}`, async () => {
      await this._writeHandoffAsync(handoffId, record);
    }, { meshDir: this.meshDir });

    // Dispatch handoff request message to recipient inbox in this.meshDir
    await writeMessage(cleanRecipient, {
      sender: cleanSender,
      type: 'task_dispatch',
      priority: 'HIGH',
      payload: {
        action: 'handoff_request',
        handoffId,
        sender: cleanSender,
        taskId,
        context
      }
    }, { meshDir: this.meshDir });

    return record;
  }

  async confirmHandoff(handoffId, recipient, metadata = {}) {
    const cleanRecipient = validateAgentName(recipient);
    const cleanId = sanitizeWindowsFilename(String(handoffId || '').trim());

    const record = await withLock(`handoff_${cleanId}`, async () => {
      const current = this._readFreshHandoffSync(cleanId);
      if (!current) throw new Error(`Handoff '${handoffId}' not found`);
      if (current.recipient !== cleanRecipient) {
        throw new Error(`Unauthorized recipient '${cleanRecipient}' cannot confirm handoff assigned to '${current.recipient}'`);
      }
      if (current.status !== 'INITIATED') {
        throw new Error(`Cannot confirm handoff in status '${current.status}'`);
      }

      if (Date.now() > new Date(current.expiresAt).getTime()) {
        current.status = 'TIMED_OUT';
        await this._writeHandoffAsync(cleanId, current);
        throw new Error(`Handoff '${handoffId}' has expired`);
      }

      current.status = 'CONFIRMED';
      current.confirmedAt = new Date().toISOString();
      current.recipientMetadata = metadata;
      await this._writeHandoffAsync(cleanId, current);
      return current;
    }, { meshDir: this.meshDir });

    // Send confirmation ACK to sender in this.meshDir
    await writeMessage(record.sender, {
      sender: cleanRecipient,
      type: 'ack',
      priority: 'HIGH',
      payload: {
        action: 'handoff_ack',
        handoffId,
        status: 'CONFIRMED',
        recipient: cleanRecipient
      }
    }, { meshDir: this.meshDir });

    return record;
  }

  async rejectHandoff(handoffId, recipient, reason = 'Worker capacity exceeded') {
    const cleanRecipient = validateAgentName(recipient);
    const cleanId = sanitizeWindowsFilename(String(handoffId || '').trim());

    const record = await withLock(`handoff_${cleanId}`, async () => {
      const current = this._readFreshHandoffSync(cleanId);
      if (!current) throw new Error(`Handoff '${handoffId}' not found`);
      if (current.recipient !== cleanRecipient) {
        throw new Error(`Unauthorized recipient '${cleanRecipient}' cannot reject handoff assigned to '${current.recipient}'`);
      }
      if (current.status !== 'INITIATED') {
        throw new Error(`Cannot reject handoff in status '${current.status}'`);
      }

      current.status = 'REJECTED';
      current.rejectedAt = new Date().toISOString();
      current.rejectReason = reason;
      await this._writeHandoffAsync(cleanId, current);
      return current;
    }, { meshDir: this.meshDir });

    // Send rejection notice to sender in this.meshDir so sender retains ownership
    await writeMessage(record.sender, {
      sender: cleanRecipient,
      type: 'task_response',
      priority: 'HIGH',
      payload: {
        action: 'handoff_nack',
        handoffId,
        status: 'REJECTED',
        reason,
        recipient: cleanRecipient
      }
    }, { meshDir: this.meshDir });

    return record;
  }

  completeHandoff(handoffId, sender, result = {}) {
    const cleanSender = validateAgentName(sender);
    const cleanId = sanitizeWindowsFilename(String(handoffId || '').trim());

    return withLockSync(`handoff_${cleanId}`, () => {
      const record = this._readFreshHandoffSync(cleanId);
      if (!record) throw new Error(`Handoff '${handoffId}' not found`);
      if (record.sender !== cleanSender) {
        throw new Error(`Unauthorized sender '${cleanSender}' cannot complete handoff owned by '${record.sender}'`);
      }
      if (record.status !== 'CONFIRMED') {
        throw new Error(`Cannot complete unconfirmed handoff in status '${record.status}'`);
      }

      record.status = 'COMPLETED';
      record.completedAt = new Date().toISOString();
      record.result = result;
      this._saveHandoffUnlocked(cleanId, record);
      return record;
    }, { meshDir: this.meshDir });
  }

  getHandoff(handoffId) {
    if (typeof handoffId !== 'string' || !handoffId.trim()) return null;
    const cleanId = sanitizeWindowsFilename(handoffId.trim());
    return this._readFreshHandoffSync(cleanId);
  }

  _saveHandoffUnlocked(cleanId, record) {
    this._trackHandoff(cleanId, record);
    const handoffPath = resolveSafePath(this.handoffsDir, `${cleanId}.json`);
    atomicWriteFileSync(handoffPath, JSON.stringify(record, null, 2));
  }

  saveHandoff(record) {
    if (!record || !record.handoffId) return;
    const cleanId = sanitizeWindowsFilename(record.handoffId);
    withLockSync(`handoff_${cleanId}`, () => {
      this._saveHandoffUnlocked(cleanId, record);
    }, { meshDir: this.meshDir });
  }
}

module.exports = {
  // Core Interface Contracts
  writeMessage,
  writeMessageSync,
  writeMessagesBatch,
  writeMessagesBatchSync,
  migrateLegacyMailboxSync,
  compactMailboxes,
  readInbox,
  readInboxSync,
  ackMessage,
  acquireLock,
  acquireLockSync,
  releaseLock,
  releaseLockSync,
  withLock,
  withLockSync,
  sanitizeAgentName,
  validateAgentName,
  resolveSafePath,
  sanitizeWindowsFilename,
  sanitizeWindowsPath,

  // Milestone 3 Enhancements (#66, #68, #70, #71)
  HandoffCoordinator,
  HeartbeatRegistry,
  pruneExpiredInbox,
  isEnvelopeExpired,
  get SubscriptionFilter() {
    return require('./fast-queue').SubscriptionFilter;
  },

  // Resiliency & Helpers
  LruCache,
  clearMeshCache,
  getMeshCacheStats,
  invalidateInboxCache,
  retryNtfsOperation,
  retryNtfsOperationSync,
  atomicWriteFile,
  atomicWriteFileSync,
  updateDiscreteEnvelopeSync,
  ensureMeshDirs,
  waitForUnread,
  clearInbox,
  clearInboxSync,
  listActiveMailboxes,
  isEphemeralMailboxName,
  EPHEMERAL_MAILBOX_REGEX,
  sleepSyncSafe,
  getInboxDir,

  // Legacy Helpers
  sanitizeName,
  safeWriteJson,
  getInboxFile,
  getChannelFile,
  writeInbox,
  checkAndMarkRead,
  sendChannelMessage,
  readChannel,
  clearChannel,
  listChannels,
  broadcastToAgents,

  // Errors
  SecurityError,
  LockTimeoutError
};
