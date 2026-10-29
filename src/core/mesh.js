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
      // Synchronous sleep using Atomics.wait if possible, or busy wait
      const start = Date.now();
      while (Date.now() - start < totalDelay) {
        // busy wait
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
    path.join(MESH_DIR, 'interrupts')
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

  return {
    messageId: envelope.id,
    path: finalFilePath,
    envelope
  };
}

/**
 * Synchronous variant of readInbox with discrete priority & legacy file fallback
 * @param {string} recipient 
 * @returns {Array<MessageEnvelope|object>}
 */
function readInboxSync(recipient) {
  const cleanRecipient = validateAgentName(recipient);
  const inboxDir = path.join(MESH_DIR, 'inbox', cleanRecipient);
  const envelopes = [];

  if (fs.existsSync(inboxDir)) {
    try {
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

      for (const file of messageFiles) {
        const fullPath = path.join(inboxDir, file);
        try {
          const content = retryNtfsOperationSync(() => fs.readFileSync(fullPath, 'utf8'));
          const parsed = JSON.parse(content);
          envelopes.push(new MessageEnvelope(parsed));
        } catch {
          continue;
        }
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
          return parsed;
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
  const normChannel = '#' + channelName.replace(/^#/, '');
  const file = getChannelFile(channelName);
  let history = [];
  if (fs.existsSync(file)) {
    try {
      history = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(history)) history = [];
    } catch {}
  }
  const msgObj = {
    id: Date.now(),
    from,
    channel: normChannel,
    message,
    timestamp: new Date().toISOString()
  };
  history.push(msgObj);
  safeWriteJson(file, history);
  return msgObj;
}

function readChannel(channelName) {
  const file = getChannelFile(channelName);
  if (!fs.existsSync(file)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function listChannels() {
  const channelsDir = path.join(MESH_DIR, 'channels');
  if (!fs.existsSync(channelsDir)) return [];
  try {
    const files = fs.readdirSync(channelsDir);
    return files.filter(f => f.endsWith('.json')).map(f => {
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

module.exports = {
  // Core Interface Contracts
  writeMessage,
  readInbox,
  readInboxSync,
  ackMessage,
  acquireLock,
  releaseLock,
  sanitizeAgentName,
  validateAgentName,
  resolveSafePath,

  // Resiliency & Helpers
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
  listChannels,
  broadcastToAgents,

  // Errors
  SecurityError,
  LockTimeoutError
};
