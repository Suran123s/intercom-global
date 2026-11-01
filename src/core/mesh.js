// src/core/mesh.js - Zero-Loss Discrete Atomic File-Mesh & Deadlock-Free CAS Advisory Locking
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { MESH_DIR } = require('../config');
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

/**
 * Resolves safe path within baseDir, preventing directory breakout
 * @param {string} baseDir 
 * @param {string} userInput 
 * @returns {string}
 */
function resolveSafePath(baseDir, userInput) {
  if (typeof userInput !== 'string' || userInput.trim() === '') {
    throw new SecurityError('Invalid input: path component must be a non-empty string');
  }
  if (PATH_TRAVERSAL_REGEX.test(userInput)) {
    throw new SecurityError(`Path traversal attack rejected: "${userInput}" contains illegal traversal tokens`);
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, userInput);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new SecurityError(`Directory jail violation: "${userInput}" resolves outside "${baseDir}"`);
  }
  return resolvedTarget;
}

const ILLEGAL_CHARS_REGEX = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const TRAILING_DOTS_SPACES_REGEX = /[\s.]+$/;
const URL_ENCODED_REGEX = /(%2e|%2f|%5c|%00)/i;

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
 * preventing Windows path traversal, ADS streams, and directory jail breakouts.
 * @param {string} baseDir 
 * @param {string} userInput 
 * @returns {string} safe absolute path
 */
function sanitizeWindowsPath(baseDir, userInput) {
  if (typeof userInput !== 'string' || userInput.trim() === '') {
    throw new SecurityError('Invalid input: path component must be a non-empty string');
  }

  const raw = userInput.trim();

  if (URL_ENCODED_REGEX.test(raw)) {
    throw new SecurityError(`Path traversal attack rejected: "${raw}" contains encoded traversal tokens`);
  }

  const colonIdx = raw.indexOf(':');
  if (colonIdx !== -1 && colonIdx !== 1) {
    throw new SecurityError(`NTFS Alternate Data Stream (ADS) attack rejected: "${raw}" contains illegal colon`);
  }

  if (PATH_TRAVERSAL_REGEX.test(raw)) {
    throw new SecurityError(`Path traversal attack rejected: "${raw}" contains traversal tokens`);
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, raw);
  const normBase = (resolvedBase + path.sep).toLowerCase();
  const normTarget = resolvedTarget.toLowerCase();

  if (!normTarget.startsWith(normBase) && normTarget !== resolvedBase.toLowerCase()) {
    throw new SecurityError(`Directory jail violation: "${userInput}" resolves outside "${baseDir}"`);
  }

  return resolvedTarget;
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

// Shared memory buffer for non-busy Atomics.wait sync sleeps
const waitSharedBuffer = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(4) : null;
const waitInt32View = waitSharedBuffer ? new Int32Array(waitSharedBuffer) : null;

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
      if (waitInt32View) {
        try {
          Atomics.wait(waitInt32View, 0, 0, totalDelay);
        } catch {
          const start = Date.now();
          while (Date.now() - start < totalDelay) {}
        }
      } else {
        const start = Date.now();
        while (Date.now() - start < totalDelay) {}
      }
    }
  }
}

/**
 * Ensures standard mesh subdirectories exist
 */
function ensureMeshDirs() {
  const dirs = [
    MESH_DIR,
    path.join(MESH_DIR, 'inbox'),
    path.join(MESH_DIR, 'locks'),
    path.join(MESH_DIR, 'archive'),
    path.join(MESH_DIR, 'registry'),
    path.join(MESH_DIR, 'interrupts'),
    path.join(MESH_DIR, 'handoffs'),
    path.join(MESH_DIR, 'heartbeats'),
    path.join(MESH_DIR, 'sessions'),
    path.join(MESH_DIR, 'dlq'),
    path.join(MESH_DIR, 'dlq', 'poison')
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch {}
    }
  }
}

ensureMeshDirs();

/**
 * Returns the inbox directory for a given agent
 * @param {string} agentName 
 * @returns {string}
 */
function getInboxDir(agentName) {
  const clean = validateAgentName(agentName);
  const inboxBase = path.join(MESH_DIR, 'inbox');
  const target = resolveSafePath(inboxBase, clean);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  return target;
}

/**
 * Writes a discrete message envelope atomically into the recipient's inbox
 * Pattern: mesh/inbox/<recipient>/<timestamp>_<uuid>.json
 * @param {string} recipient 
 * @param {MessageEnvelope|object} envelopeData 
 * @returns {Promise<{ messageId: string, path: string, envelope: MessageEnvelope }>}
 */
async function writeMessage(recipient, envelopeData) {
  const cleanRecipient = validateAgentName(recipient);
  const envelope = envelopeData instanceof MessageEnvelope
    ? envelopeData
    : (envelopeData && typeof envelopeData.toJSON === 'function'
      ? envelopeData
      : MessageEnvelope.create({ ...envelopeData, recipient: cleanRecipient }));

  const inboxDir = getInboxDir(cleanRecipient);
  const tmpFileName = `.tmp_${envelope.id}_${Date.now()}.tmp`;
  const tmpFilePath = path.join(inboxDir, tmpFileName);
  const finalFileName = `${envelope.epochMs}_${envelope.id}.json`;
  const finalFilePath = path.join(inboxDir, finalFileName);

  const serialized = JSON.stringify(envelope.toJSON ? envelope.toJSON() : envelope, null, 2);

  // 1. Write to temporary file in same directory & flush to disk
  await retryNtfsOperation(async () => {
    await fs.promises.writeFile(tmpFilePath, serialized, 'utf8');
  });

  // 2. Atomic rename to final path with Windows NTFS backoff retry
  await retryNtfsOperation(async () => {
    await fs.promises.rename(tmpFilePath, finalFilePath);
  });

  // 3. Mirror to workspace inbox for Antigravity dual mailbox architecture
  if (cleanRecipient.toLowerCase() === 'antigravity') {
    try {
      const workspaceInbox = path.resolve(process.cwd(), '.agents', 'mesh', 'inbox', 'antigravity');
      if (workspaceInbox !== inboxDir) {
        if (!fs.existsSync(workspaceInbox)) fs.mkdirSync(workspaceInbox, { recursive: true });
        const wsTmp = path.join(workspaceInbox, tmpFileName);
        const wsFinal = path.join(workspaceInbox, finalFileName);
        await retryNtfsOperation(async () => {
          await fs.promises.writeFile(wsTmp, serialized, 'utf8');
        });
        await retryNtfsOperation(async () => {
          await fs.promises.rename(wsTmp, wsFinal);
        });
      }
    } catch {}
  }

  // Invalidate local in-memory inbox cache
  inboxDirCache.delete(inboxDir);

  return {
    messageId: envelope.id,
    path: finalFilePath,
    envelope
  };
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

/**
 * Synchronous variant of discrete atomic message writing
 * @param {string} recipient 
 * @param {MessageEnvelope|object} envelopeData 
 * @returns {{ messageId: string, path: string, envelope: MessageEnvelope }}
 */
function writeMessageSync(recipient, envelopeData) {
  const cleanRecipient = validateAgentName(recipient);
  const envelope = envelopeData instanceof MessageEnvelope
    ? envelopeData
    : (envelopeData && typeof envelopeData.toJSON === 'function'
      ? envelopeData
      : MessageEnvelope.create({ ...envelopeData, recipient: cleanRecipient }));

  const inboxDir = getInboxDir(cleanRecipient);
  const tmpFileName = `.tmp_${envelope.id}_${Date.now()}.tmp`;
  const tmpFilePath = path.join(inboxDir, tmpFileName);
  const finalFileName = `${envelope.epochMs}_${envelope.id}.json`;
  const finalFilePath = path.join(inboxDir, finalFileName);

  const serialized = JSON.stringify(envelope.toJSON ? envelope.toJSON() : envelope, null, 2);

  retryNtfsOperationSync(() => {
    fs.writeFileSync(tmpFilePath, serialized, 'utf8');
  });

  retryNtfsOperationSync(() => {
    fs.renameSync(tmpFilePath, finalFilePath);
  });

  // Mirror to workspace inbox for Antigravity dual mailbox architecture
  if (cleanRecipient.toLowerCase() === 'antigravity') {
    try {
      const workspaceInbox = path.resolve(process.cwd(), '.agents', 'mesh', 'inbox', 'antigravity');
      if (workspaceInbox !== inboxDir) {
        if (!fs.existsSync(workspaceInbox)) fs.mkdirSync(workspaceInbox, { recursive: true });
        const wsTmp = path.join(workspaceInbox, tmpFileName);
        const wsFinal = path.join(workspaceInbox, finalFileName);
        retryNtfsOperationSync(() => {
          fs.writeFileSync(wsTmp, serialized, 'utf8');
        });
        retryNtfsOperationSync(() => {
          fs.renameSync(wsTmp, wsFinal);
        });
      }
    } catch {}
  }

  inboxDirCache.delete(inboxDir);

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

  const batchCount = envelopesData.length;
  // Dynamic lock TTL: base 5000ms + 50ms per message to prevent premature stale lock takeover
  const lockTtlMs = options.lockTtlMs || Math.max(5000, batchCount * 50);
  const timeoutMs = options.timeoutMs || 15000;

  return await withLock(cleanRecipient, async () => {
    const inboxDir = getInboxDir(cleanRecipient);
    const results = [];
    const now = Date.now();

    // Prepare envelopes and normalize timestamps
    const prepared = envelopesData.map((data, idx) => {
      const envelope = data instanceof MessageEnvelope
        ? data
        : (data && typeof data.toJSON === 'function'
          ? data
          : MessageEnvelope.create({ ...data, recipient: cleanRecipient }));
      
      // Ensure epochMs monotonicity within the batch
      envelope.epochMs = (envelope.epochMs || now) + idx;
      return envelope;
    });

    // Write all messages within the single held lock
    for (let i = 0; i < prepared.length; i++) {
      const envelope = prepared[i];
      const tmpFileName = `.tmp_${envelope.id}_${now}_${i}.tmp`;
      const tmpFilePath = path.join(inboxDir, tmpFileName);
      const finalFileName = `${envelope.epochMs}_${envelope.id}.json`;
      const finalFilePath = path.join(inboxDir, finalFileName);
      const serialized = JSON.stringify(envelope.toJSON ? envelope.toJSON() : envelope, null, 2);

      // 1. Write tmp file
      await retryNtfsOperation(async () => {
        await fs.promises.writeFile(tmpFilePath, serialized, 'utf8');
      });

      // 2. Atomic rename to final message file
      await retryNtfsOperation(async () => {
        await fs.promises.rename(tmpFilePath, finalFilePath);
      });

      // 3. Mirror to Antigravity dual mailbox if applicable
      if (cleanRecipient.toLowerCase() === 'antigravity') {
        try {
          const workspaceInbox = path.resolve(process.cwd(), '.agents', 'mesh', 'inbox', 'antigravity');
          if (workspaceInbox !== inboxDir) {
            if (!fs.existsSync(workspaceInbox)) fs.mkdirSync(workspaceInbox, { recursive: true });
            const wsTmp = path.join(workspaceInbox, tmpFileName);
            const wsFinal = path.join(workspaceInbox, finalFileName);
            await retryNtfsOperation(async () => {
              await fs.promises.writeFile(wsTmp, serialized, 'utf8');
            });
            await retryNtfsOperation(async () => {
              await fs.promises.rename(wsTmp, wsFinal);
            });
          }
        } catch {}
      }

      results.push({
        messageId: envelope.id,
        path: finalFilePath,
        envelope
      });
    }

    // Invalidate inbox directory cache once after whole batch
    inboxDirCache.delete(inboxDir);
    return results;
  }, { ttlMs: lockTtlMs, timeoutMs });
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

  const batchCount = envelopesData.length;
  const lockTtlMs = options.lockTtlMs || Math.max(5000, batchCount * 50);
  const timeoutMs = options.timeoutMs || 15000;

  return withLockSync(cleanRecipient, () => {
    const inboxDir = getInboxDir(cleanRecipient);
    const results = [];
    const now = Date.now();

    const prepared = envelopesData.map((data, idx) => {
      const envelope = data instanceof MessageEnvelope
        ? data
        : (data && typeof data.toJSON === 'function'
          ? data
          : MessageEnvelope.create({ ...data, recipient: cleanRecipient }));
      
      envelope.epochMs = (envelope.epochMs || now) + idx;
      return envelope;
    });

    for (let i = 0; i < prepared.length; i++) {
      const envelope = prepared[i];
      const tmpFileName = `.tmp_${envelope.id}_${now}_${i}.tmp`;
      const tmpFilePath = path.join(inboxDir, tmpFileName);
      const finalFileName = `${envelope.epochMs}_${envelope.id}.json`;
      const finalFilePath = path.join(inboxDir, finalFileName);
      const serialized = JSON.stringify(envelope.toJSON ? envelope.toJSON() : envelope, null, 2);

      retryNtfsOperationSync(() => {
        fs.writeFileSync(tmpFilePath, serialized, 'utf8');
      });

      retryNtfsOperationSync(() => {
        fs.renameSync(tmpFilePath, finalFilePath);
      });

      if (cleanRecipient.toLowerCase() === 'antigravity') {
        try {
          const workspaceInbox = path.resolve(process.cwd(), '.agents', 'mesh', 'inbox', 'antigravity');
          if (workspaceInbox !== inboxDir) {
            if (!fs.existsSync(workspaceInbox)) fs.mkdirSync(workspaceInbox, { recursive: true });
            const wsTmp = path.join(workspaceInbox, tmpFileName);
            const wsFinal = path.join(workspaceInbox, finalFileName);
            retryNtfsOperationSync(() => {
              fs.writeFileSync(wsTmp, serialized, 'utf8');
            });
            retryNtfsOperationSync(() => {
              fs.renameSync(wsTmp, wsFinal);
            });
          }
        } catch {}
      }

      results.push({
        messageId: envelope.id,
        path: finalFilePath,
        envelope
      });
    }

    inboxDirCache.delete(inboxDir);
    return results;
  }, { ttlMs: lockTtlMs, timeoutMs });
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

  const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp'));
  const now = Date.now();
  const active = [];
  const pruned = [];

  for (const f of files) {
    const filePath = path.join(inboxDir, f);
    try {
      const msg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (isEnvelopeExpired(msg, now)) {
        if (dlqDir) {
          if (!fs.existsSync(dlqDir)) fs.mkdirSync(dlqDir, { recursive: true });
          msg.deadLetterReason = 'EXPIRED_TTL';
          fs.writeFileSync(path.join(dlqDir, `expired_${f}`), JSON.stringify(msg, null, 2), 'utf8');
        }
        try { fs.unlinkSync(filePath); } catch {}
        pruned.push(msg);
      } else {
        active.push(msg);
      }
    } catch {}
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
  const tempTtlMs = options.tempTtlMs || 60000;
  const targetMailbox = options.targetMailbox ? validateAgentName(options.targetMailbox) : null;

  const inboxBase = path.join(MESH_DIR, 'inbox');
  const locksDir = path.join(MESH_DIR, 'locks');
  const report = {
    examined: 0,
    prunedDirs: 0,
    prunedEmptyMailboxes: [],
    prunedTempFiles: 0,
    reclaimedBytes: 0,
    skippedLocked: [],
    dryRun
  };

  if (!fs.existsSync(inboxBase)) {
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
    if (fs.existsSync(lockDir)) {
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
                await retryNtfsOperation(async () => {
                  await fs.promises.unlink(fullFilePath);
                });
              }
            }
          } catch {}
        }
      } else if (/^\d+_[a-zA-Z0-9\-]+\.json$/.test(f)) {
        if (options.pruneExpired !== false) {
          const fullFilePath = path.join(fullDir, f);
          try {
            const raw = fs.readFileSync(fullFilePath, 'utf8');
            const msg = JSON.parse(raw);
            if (isEnvelopeExpired(msg, now)) {
              const dlqDir = path.join(MESH_DIR, 'dlq');
              if (!fs.existsSync(dlqDir)) fs.mkdirSync(dlqDir, { recursive: true });
              msg.deadLetterReason = 'EXPIRED_TTL';
              fs.writeFileSync(path.join(dlqDir, `expired_${f}`), JSON.stringify(msg, null, 2), 'utf8');
              if (!dryRun) {
                fs.unlinkSync(fullFilePath);
              }
              report.prunedExpired = (report.prunedExpired || 0) + 1;
              continue;
            }
          } catch {}
        }
        activeMessagesCount++;
      }
    }

    // Prune empty mailbox directories if 0 active messages remain
    if (pruneEmpty && activeMessagesCount === 0) {
      const isEmptyNow = dryRun ? (files.length - prunedTempInMailbox === 0) : true;
      if (isEmptyNow) {
        if (!dryRun) {
          let remainingFiles = [];
          try {
            remainingFiles = await fs.promises.readdir(fullDir);
          } catch {}

          if (remainingFiles.length === 0) {
            report.prunedEmptyMailboxes.push(entryName);
            try {
              await retryNtfsOperation(async () => {
                await fs.promises.rmdir(fullDir);
              });
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
  const inboxDir = path.join(MESH_DIR, 'inbox', cleanRecipient);
  const envelopes = [];
  const limit = (options && typeof options.limit === 'number') ? options.limit : null;
  const resolvedOrder = (options && options.order) || ((options && options.newestFirst) ? 'desc' : 'asc');

  if (fs.existsSync(inboxDir)) {
    try {
      const dirStat = fs.statSync(inboxDir);
      const dirCached = inboxDirCache.get(inboxDir);

      if (dirCached && dirCached.mtimeMs === dirStat.mtimeMs) {
        if (dirCached.allLoaded) {
          const list = resolvedOrder === 'desc' ? dirCached.allDesc : dirCached.allAsc;
          if (list.length > 0) {
            return limit !== null ? list.slice(0, limit) : [...list];
          }
        } else if (dirCached.limit !== null && limit !== null && dirCached.limit >= limit && dirCached.order === resolvedOrder) {
          if (dirCached.envelopes.length > 0) {
            return dirCached.envelopes.slice(0, limit);
          }
        }
      }

      const files = retryNtfsOperationSync(() => fs.readdirSync(inboxDir));
      const messageFiles = files.filter(f => /^\d+_[a-zA-Z0-9\-]+\.json$/.test(f));

      messageFiles.sort((a, b) => {
        const partsA = a.split('_');
        const partsB = b.split('_');
        const tsA = parseInt(partsA[0], 10) || 0;
        const tsB = parseInt(partsB[0], 10) || 0;
        if (tsA !== tsB) return tsA - tsB;
        const idA = partsA.slice(1).join('_').replace(/\.json$/, '');
        const idB = partsB.slice(1).join('_').replace(/\.json$/, '');
        return idA.localeCompare(idB);
      });

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
            const env = new MessageEnvelope(parsed);
            if (fileEnvelopeCache.size >= MAX_FILE_CACHE_ENTRIES) {
              const oldestKey = fileEnvelopeCache.keys().next().value;
              fileEnvelopeCache.delete(oldestKey);
            }
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
        envelopes.push(...(limit !== null ? list.slice(0, limit) : list));
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
        envelopes.push(...loadedEnvelopes);
      }
    } catch {}
  }

  // If no discrete messages found, check legacy file (mesh/<recipient>.json)
  if (envelopes.length === 0) {
    const legacyFile = getInboxFile(cleanRecipient);
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
  const inboxDir = getInboxDir(cleanRecipient);

  if (!fs.existsSync(inboxDir)) return false;

  const files = await retryNtfsOperation(async () => {
    return await fs.promises.readdir(inboxDir);
  });

  const targetFile = files.find(f => f.includes(messageId));
  if (!targetFile) return false;

  const srcPath = path.join(inboxDir, targetFile);

  if (options.unlink === true) {
    await retryNtfsOperation(async () => {
      if (fs.existsSync(srcPath)) {
        await fs.promises.unlink(srcPath);
      }
    });
    inboxDirCache.delete(inboxDir);
    return true;
  }

  // Move to archive/<date>/<agentName>/<targetFile>
  const today = new Date().toISOString().slice(0, 10);
  const archiveDir = path.join(MESH_DIR, 'archive', today, cleanRecipient);
  if (!fs.existsSync(archiveDir)) {
    await fs.promises.mkdir(archiveDir, { recursive: true });
  }
  const destPath = path.join(archiveDir, targetFile);

  await retryNtfsOperation(async () => {
    await fs.promises.rename(srcPath, destPath);
  });

  inboxDirCache.delete(inboxDir);
  return true;
}

/**
 * Deadlock-Free Compare-And-Swap (CAS) Directory Advisory Locking
 * @param {string} resourceName 
 * @param {number} ttlMs Default 3000ms
 * @param {object} options { timeoutMs: 10000 }
 * @returns {Promise<{ lockDir: string, resourceName: string, token: string, ownerPid: number }>}
 */
async function acquireLock(resourceName, ttlMs = 3000, options = {}) {
  const cleanName = sanitizeAgentName(resourceName);
  const locksDir = path.join(MESH_DIR, 'locks');
  if (!fs.existsSync(locksDir)) {
    fs.mkdirSync(locksDir, { recursive: true });
  }

  const lockDir = path.join(locksDir, `${cleanName}.lock`);
  const metaFile = path.join(lockDir, 'metadata.json');
  const timeoutMs = options.timeoutMs || 10000;
  const startTime = Date.now();
  const token = crypto.randomUUID();

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Atomic directory creation
      fs.mkdirSync(lockDir);

      // Successfully acquired lock - write metadata
      const meta = {
        ownerPid: process.pid,
        createdAt: Date.now(),
        ttlMs,
        resourceName: cleanName,
        token
      };
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');

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

      // Check for stale lock
      let isStale = false;
      try {
        if (fs.existsSync(metaFile)) {
          const raw = fs.readFileSync(metaFile, 'utf8');
          const meta = JSON.parse(raw);
          const age = Date.now() - meta.createdAt;

          const effectiveTtl = meta.ttlMs || ttlMs;
          if (age > effectiveTtl) {
            isStale = true;
          } else if (meta.ownerPid && meta.ownerPid !== process.pid) {
            // Check if owner process is dead
            try {
              process.kill(meta.ownerPid, 0);
            } catch (killErr) {
              if (killErr.code === 'ESRCH') {
                isStale = true;
              }
            }
          }
        } else {
          // Empty or broken lock dir older than 1 second is considered stale
          const stat = fs.statSync(lockDir);
          if (Date.now() - stat.mtimeMs > ttlMs) {
            isStale = true;
          }
        }
      } catch {
        // Inability to read metadata may mean it's being written or is corrupted
      }

      if (isStale) {
        const stalePurgeDir = `${lockDir}.stale.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
        try {
          fs.renameSync(lockDir, stalePurgeDir);
          const purgeMeta = path.join(stalePurgeDir, 'metadata.json');
          if (fs.existsSync(purgeMeta)) fs.unlinkSync(purgeMeta);
          fs.rmdirSync(stalePurgeDir);
        } catch {}
        continue;
      }

      // Lock is actively held; back off with jitter before next attempt
      const jitter = Math.floor(Math.random() * 25) + 15;
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }

  throw new LockTimeoutError(`Lock acquisition timed out after ${timeoutMs}ms for resource "${resourceName}"`);
}

/**
 * Releases a CAS advisory lock safely
 * @param {object} lockHandle 
 */
async function releaseLock(lockHandle) {
  if (!lockHandle || !lockHandle.lockDir) return;
  const { lockDir, token } = lockHandle;

  if (!fs.existsSync(lockDir)) return;

  const metaFile = path.join(lockDir, 'metadata.json');
  try {
    if (fs.existsSync(metaFile)) {
      if (token) {
        try {
          const raw = fs.readFileSync(metaFile, 'utf8');
          const meta = JSON.parse(raw);
          if (meta.token && meta.token !== token) {
            // Token mismatch: lock has been reassigned/expired
            return;
          }
        } catch {}
      }
      retryNtfsOperationSync(() => fs.unlinkSync(metaFile));
    }
    retryNtfsOperationSync(() => fs.rmdirSync(lockDir));
  } catch (err) {
    // If directory already removed or locked, ignore
  }
}

/**
 * Synchronous variant of acquireLock
 */
function acquireLockSync(resourceName, ttlMs = 3000, options = {}) {
  const cleanName = sanitizeAgentName(resourceName);
  const locksDir = path.join(MESH_DIR, 'locks');
  if (!fs.existsSync(locksDir)) {
    try { fs.mkdirSync(locksDir, { recursive: true }); } catch {}
  }

  const lockDir = path.join(locksDir, `${cleanName}.lock`);
  const metaFile = path.join(lockDir, 'metadata.json');
  const timeoutMs = options.timeoutMs || 10000;
  const startTime = Date.now();
  const token = crypto.randomUUID();

  while (Date.now() - startTime < timeoutMs) {
    try {
      fs.mkdirSync(lockDir);
      const meta = {
        ownerPid: process.pid,
        createdAt: Date.now(),
        ttlMs,
        resourceName: cleanName,
        token
      };
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
      return {
        lockDir,
        resourceName: cleanName,
        token,
        ownerPid: process.pid
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Stale lock detection
      let isStale = false;
      try {
        if (fs.existsSync(metaFile)) {
          const raw = fs.readFileSync(metaFile, 'utf8');
          const meta = JSON.parse(raw);
          const age = Date.now() - meta.createdAt;
          const effectiveTtl = meta.ttlMs || ttlMs;
          if (age > effectiveTtl) {
            isStale = true;
          } else if (meta.ownerPid && meta.ownerPid !== process.pid) {
            try {
              process.kill(meta.ownerPid, 0);
            } catch (kErr) {
              if (kErr.code === 'ESRCH') isStale = true;
            }
          }
        } else {
          const stat = fs.statSync(lockDir);
          if (Date.now() - stat.mtimeMs > ttlMs) isStale = true;
        }
      } catch {}

      if (isStale) {
        const stalePurgeDir = `${lockDir}.stale.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
        try {
          fs.renameSync(lockDir, stalePurgeDir);
          const purgeMeta = path.join(stalePurgeDir, 'metadata.json');
          if (fs.existsSync(purgeMeta)) fs.unlinkSync(purgeMeta);
          fs.rmdirSync(stalePurgeDir);
        } catch {}
        continue;
      }

      // Jitter sleep
      const jitter = Math.floor(Math.random() * 25) + 15;
      if (waitInt32View) {
        try { Atomics.wait(waitInt32View, 0, 0, jitter); } catch {
          const s = Date.now(); while (Date.now() - s < jitter) {}
        }
      } else {
        const s = Date.now(); while (Date.now() - s < jitter) {}
      }
    }
  }

  throw new LockTimeoutError(`Sync lock acquisition timed out after ${timeoutMs}ms for resource "${resourceName}"`);
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
    if (fs.existsSync(metaFile)) {
      if (token) {
        try {
          const raw = fs.readFileSync(metaFile, 'utf8');
          const meta = JSON.parse(raw);
          if (meta.token && meta.token !== token) return;
        } catch {}
      }
      retryNtfsOperationSync(() => fs.unlinkSync(metaFile));
    }
    retryNtfsOperationSync(() => fs.rmdirSync(lockDir));
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

    const cleanup = () => {
      resolved = true;
      if (timer) clearTimeout(timer);
      if (pollInterval) clearInterval(pollInterval);
      if (watcher) {
        try { watcher.close(); } catch {}
      }
    };

    const check = async () => {
      if (resolved) return;
      inboxDirCache.delete(inboxDir);
      const msgs = await readInbox(cleanRecipient);
      if (msgs.length > 0) {
        cleanup();
        resolve(msgs);
      }
    };

    try {
      watcher = fs.watch(inboxDir, () => {
        check();
      });
    } catch {}

    // Backup polling check every 250ms in case fs.watch events are dropped
    pollInterval = setInterval(check, 250);

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
  const inboxDir = getInboxDir(cleanRecipient);
  let count = 0;

  if (fs.existsSync(inboxDir)) {
    try {
      const files = retryNtfsOperationSync(() => fs.readdirSync(inboxDir));
      for (const f of files) {
        if (f.endsWith('.json') || f.endsWith('.tmp')) {
          try {
            retryNtfsOperationSync(() => fs.unlinkSync(path.join(inboxDir, f)));
            count++;
          } catch {}
        }
      }
    } catch {}
  }

  // Also clear legacy file if present
  const legacyFile = getInboxFile(cleanRecipient);
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
async function listActiveMailboxes() {
  const inboxBase = path.join(MESH_DIR, 'inbox');
  const mailboxes = [];
  const seen = new Set();

  if (fs.existsSync(inboxBase)) {
    try {
      const dirs = await fs.promises.readdir(inboxBase);
      for (const d of dirs) {
        const fullDir = path.join(inboxBase, d);
        try {
          const stat = await fs.promises.stat(fullDir);
          if (stat.isDirectory()) {
            const files = await fs.promises.readdir(fullDir);
            const msgs = files.filter(f => /^\d+_[a-zA-Z0-9\-]+\.json$/.test(f));
            mailboxes.push({
              name: d,
              total: msgs.length,
              unread: msgs.length
            });
            seen.add(d);
          }
        } catch {}
      }
    } catch {}
  }

  // Also check legacy mesh/*.json files
  if (fs.existsSync(MESH_DIR)) {
    try {
      const rootFiles = await fs.promises.readdir(MESH_DIR);
      for (const rf of rootFiles) {
        if (rf.endsWith('.json') && rf !== 'dlq.json' && rf !== 'daemon.pid') {
          const name = rf.replace('.json', '');
          if (!seen.has(name)) {
            try {
              const content = JSON.parse(await fs.promises.readFile(path.join(MESH_DIR, rf), 'utf8'));
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
  const clean = base.replace(/[^a-zA-Z0-9_\-#.]/g, '_').replace(/^\.+/, '');
  return clean || 'unknown';
}

function safeWriteJson(targetPath, data) {
  const tmp = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
  }
}

function getInboxFile(agentName) {
  const raw = (agentName || 'unknown').toString().toLowerCase().trim();
  const resolvedMeshDir = path.resolve(MESH_DIR);
  if (raw.includes('#')) {
    const parts = raw.split('#');
    const agent = sanitizeName(parts[0]);
    const session = sanitizeName(parts.slice(1).join('-'));
    return path.join(resolvedMeshDir, `${agent}-${session}.json`);
  }
  const clean = sanitizeName(raw);
  return path.join(resolvedMeshDir, `${clean}.json`);
}

function getChannelFile(channelName) {
  const clean = sanitizeName((channelName || '').replace(/^#/, ''));
  const channelsDir = path.join(MESH_DIR, 'channels');
  if (!fs.existsSync(channelsDir)) {
    try { fs.mkdirSync(channelsDir, { recursive: true }); } catch {}
  }
  const resolvedDir = path.resolve(channelsDir);
  return path.join(resolvedDir, `${clean}.json`);
}

function writeInbox(agentName, messages) {
  const clean = sanitizeName(agentName);
  const target = getInboxFile(clean);
  safeWriteJson(target, messages);
  const inboxDir = path.join(MESH_DIR, 'inbox', clean);
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
  const channelsDir = path.dirname(file);

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

    if (!fs.existsSync(channelsDir)) {
      try { fs.mkdirSync(channelsDir, { recursive: true }); } catch {}
    }

    const tmpFile = path.join(channelsDir, `.tmp_chan_${clean}_${Date.now()}.tmp`);
    const serialized = JSON.stringify(history, null, 2);

    retryNtfsOperationSync(() => {
      fs.writeFileSync(tmpFile, serialized, 'utf8');
    });
    retryNtfsOperationSync(() => {
      fs.renameSync(tmpFile, file);
    });

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
  const channelsDir = path.join(MESH_DIR, 'channels');
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
  constructor(meshDir = process.env.INTERCOM_MESH_DIR || MESH_DIR) {
    this.meshDir = meshDir || MESH_DIR;
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

    const filePath = path.join(this.heartbeatDir, `${clean}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  writeHeartbeat(agent, metadata = {}) {
    return this.touchHeartbeat(agent, metadata);
  }

  getPeerStatus(agent, ttlMs = 30000, options = {}) {
    const clean = validateAgentName(agent);
    const filePath = path.join(this.heartbeatDir, `${clean}.json`);
    if (!fs.existsSync(filePath)) {
      return { status: 'unknown', online: false };
    }

    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const ageMs = Date.now() - record.epochMs;
      let isOnline = ageMs <= ttlMs;
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
      const agent = f.replace(/\.json$/, '');
      const st = this.getPeerStatus(agent, ttlMs, options);
      if (st.online) {
        live.push(st);
      }
    }
    return live;
  }

  evictStalePeers(ttlMs = 60000, options = {}) {
    if (!fs.existsSync(this.heartbeatDir)) return [];
    const files = fs.readdirSync(this.heartbeatDir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp'));
    const evicted = [];

    for (const f of files) {
      const filePath = path.join(this.heartbeatDir, f);
      try {
        const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const ageMs = Date.now() - record.epochMs;
        let dead = ageMs > ttlMs;

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

class HandoffCoordinator {
  constructor(meshDir = process.env.INTERCOM_MESH_DIR || MESH_DIR) {
    this.meshDir = meshDir || MESH_DIR;
    this.handoffsDir = path.join(this.meshDir, 'handoffs');
    if (!fs.existsSync(this.handoffsDir)) {
      try { fs.mkdirSync(this.handoffsDir, { recursive: true }); } catch {}
    }
    this.activeHandoffs = new Map();
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

    this.activeHandoffs.set(handoffId, record);
    const handoffPath = path.join(this.handoffsDir, `${handoffId}.json`);
    fs.writeFileSync(handoffPath, JSON.stringify(record, null, 2), 'utf8');

    // Dispatch handoff request message to recipient inbox
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
    });

    return record;
  }

  async confirmHandoff(handoffId, recipient, metadata = {}) {
    const cleanRecipient = validateAgentName(recipient);
    const record = this.getHandoff(handoffId);
    if (!record) throw new Error(`Handoff '${handoffId}' not found`);
    if (record.recipient !== cleanRecipient) {
      throw new Error(`Unauthorized recipient '${cleanRecipient}' cannot confirm handoff assigned to '${record.recipient}'`);
    }
    if (record.status !== 'INITIATED') {
      throw new Error(`Cannot confirm handoff in status '${record.status}'`);
    }

    if (Date.now() > new Date(record.expiresAt).getTime()) {
      record.status = 'TIMED_OUT';
      this.saveHandoff(record);
      throw new Error(`Handoff '${handoffId}' has expired`);
    }

    record.status = 'CONFIRMED';
    record.confirmedAt = new Date().toISOString();
    record.recipientMetadata = metadata;
    this.saveHandoff(record);

    // Send confirmation ACK to sender
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
    });

    return record;
  }

  async rejectHandoff(handoffId, recipient, reason = 'Worker capacity exceeded') {
    const cleanRecipient = validateAgentName(recipient);
    const record = this.getHandoff(handoffId);
    if (!record) throw new Error(`Handoff '${handoffId}' not found`);

    record.status = 'REJECTED';
    record.rejectedAt = new Date().toISOString();
    record.rejectReason = reason;
    this.saveHandoff(record);

    // Send rejection notice to sender so sender retains ownership
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
    });

    return record;
  }

  completeHandoff(handoffId, sender, result = {}) {
    const cleanSender = validateAgentName(sender);
    const record = this.getHandoff(handoffId);
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
    this.saveHandoff(record);
    return record;
  }

  getHandoff(handoffId) {
    if (this.activeHandoffs.has(handoffId)) {
      return this.activeHandoffs.get(handoffId);
    }
    const handoffPath = path.join(this.handoffsDir, `${handoffId}.json`);
    if (fs.existsSync(handoffPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
        this.activeHandoffs.set(handoffId, parsed);
        return parsed;
      } catch {}
    }
    return null;
  }

  saveHandoff(record) {
    this.activeHandoffs.set(record.handoffId, record);
    const handoffPath = path.join(this.handoffsDir, `${record.handoffId}.json`);
    fs.writeFileSync(handoffPath, JSON.stringify(record, null, 2), 'utf8');
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
  retryNtfsOperation,
  retryNtfsOperationSync,
  waitForUnread,
  clearInbox,
  clearInboxSync,
  listActiveMailboxes,
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
