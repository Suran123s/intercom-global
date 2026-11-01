// src/bridges/antigravity-bridge.js - Google Antigravity Web UI & Multi-Mailbox Bridge
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MESH_DIR } = require('../config');

const ANTIGRAVITY_DEFAULT_URL = process.env.ANTIGRAVITY_URL || 'https://127.0.0.1:58055/';

let cachedConfig = null;
let cachedConfigTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000;
const OFFLINE_CACHE_TTL_MS = 5000;
let cachedOfflineResult = null;
let cachedOfflineTimestamp = 0;

// Shared memory buffer for non-busy Atomics.wait sync sleeps
const agWaitBuffer = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(4) : null;
const agWaitInt32 = agWaitBuffer ? new Int32Array(agWaitBuffer) : null;

// Caches for Antigravity dual mailboxes
const agInboxDirCache = new Map();
const agFileCache = new Map();

/**
 * Custom HTTPS Agent allowing local self-signed dev certificates for Antigravity web UI
 */
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * Fetches Antigravity runtime web UI configuration and dynamic CSRF token
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {number} [options.timeoutMs=3000]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {Promise<{ online: boolean, csrfToken: string|null, config: object|null, url: string, error?: string }>}
 */
async function getAntigravityConfig(options = {}) {
  const url = options.url || ANTIGRAVITY_DEFAULT_URL;
  const timeoutMs = options.timeoutMs || 3000;
  const now = Date.now();

  if (!options.forceRefresh && cachedConfig && (now - cachedConfigTimestamp < CACHE_TTL_MS)) {
    return {
      online: true,
      csrfToken: cachedConfig.csrfToken || null,
      config: cachedConfig,
      url
    };
  }

  if (!options.forceRefresh && cachedOfflineResult && (now - cachedOfflineTimestamp < OFFLINE_CACHE_TTL_MS)) {
    return cachedOfflineResult;
  }

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const req = https.get(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 58055,
          path: parsedUrl.pathname || '/',
          agent: httpsAgent,
          timeout: timeoutMs,
          headers: {
            'User-Agent': 'intercom-global/2.0.0 (antigravity-bridge)'
          }
        },
        (res) => {
          let rawData = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            rawData += chunk;
          });
          res.on('end', () => {
            let extractedConfig = null;
            let csrfToken = null;

            // Pattern 1: window.__APP_CONFIG__ = { ... };
            const appConfigMatch = rawData.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\});/s);
            if (appConfigMatch) {
              try {
                extractedConfig = JSON.parse(appConfigMatch[1]);
                csrfToken = extractedConfig.csrfToken || null;
              } catch {}
            }

            // Pattern 2: standalone "csrfToken":"..."
            if (!csrfToken) {
              const tokenMatch = rawData.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i);
              if (tokenMatch) {
                csrfToken = tokenMatch[1];
                if (!extractedConfig) extractedConfig = { csrfToken };
              }
            }

            if (res.statusCode >= 200 && res.statusCode < 400) {
              cachedConfig = extractedConfig || { csrfToken };
              cachedConfigTimestamp = Date.now();
              cachedOfflineResult = null;
              cachedOfflineTimestamp = 0;

              resolve({
                online: true,
                csrfToken: csrfToken || null,
                config: cachedConfig,
                url
              });
            } else {
              const offlineRes = {
                online: false,
                csrfToken: null,
                config: null,
                url,
                error: `HTTP ${res.statusCode}`
              };
              cachedOfflineResult = offlineRes;
              cachedOfflineTimestamp = Date.now();
              resolve(offlineRes);
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        const offlineRes = {
          online: false,
          csrfToken: null,
          config: null,
          url,
          error: 'Connection timeout'
        };
        cachedOfflineResult = offlineRes;
        cachedOfflineTimestamp = Date.now();
        resolve(offlineRes);
      });

      req.on('error', (err) => {
        const offlineRes = {
          online: false,
          csrfToken: null,
          config: null,
          url,
          error: err.message
        };
        cachedOfflineResult = offlineRes;
        cachedOfflineTimestamp = Date.now();
        resolve(offlineRes);
      });
    } catch (err) {
      const offlineRes = {
        online: false,
        csrfToken: null,
        config: null,
        url,
        error: err.message
      };
      cachedOfflineResult = offlineRes;
      cachedOfflineTimestamp = Date.now();
      resolve(offlineRes);
    }
  });
}

/**
 * Resolves Antigravity's dual mailbox directories:
 * 1. User home: ~/.intercom-global/mesh/inbox/antigravity/
 * 2. Workspace: .agents/mesh/inbox/antigravity/
 * @returns {string[]}
 */
function getDualMailboxDirs() {
  const dirs = [];
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';

  if (homeDir) {
    dirs.push(path.join(homeDir, '.intercom-global', 'mesh', 'inbox', 'antigravity'));
  } else {
    dirs.push(path.join(MESH_DIR, 'inbox', 'antigravity'));
  }

  const workspaceInbox = path.resolve(process.cwd(), '.agents', 'mesh', 'inbox', 'antigravity');
  if (!dirs.includes(workspaceInbox)) {
    dirs.push(workspaceInbox);
  }

  return dirs;
}

/**
 * Windows NTFS file-lock retry helper
 */
async function retryNtfsOperation(fn, maxAttempts = 5) {
  const delays = [20, 40, 80, 160, 320];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLock = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!isLock || attempt === maxAttempts - 1) throw err;
      const delay = delays[attempt] + Math.floor(Math.random() * 15);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Synchronous variant of NTFS retry
 */
function retryNtfsOperationSync(fn, maxAttempts = 5) {
  const delays = [20, 40, 80, 160, 320];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      const isLock = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!isLock || attempt === maxAttempts - 1) throw err;
      const delay = delays[attempt] + Math.floor(Math.random() * 15);
      if (agWaitInt32) {
        try {
          Atomics.wait(agWaitInt32, 0, 0, delay);
        } catch {
          const start = Date.now();
          while (Date.now() - start < delay) {}
        }
      } else {
        const start = Date.now();
        while (Date.now() - start < delay) {}
      }
    }
  }
}

/**
 * Routes a message envelope into Antigravity's dual mailboxes and checks webview status
 * @param {object} messageData
 * @param {object} [options]
 * @returns {Promise<{ success: boolean, messageId: string, dualMailboxes: string[], csrfTokenPresent: boolean, webViewOnline: boolean }>}
 */
async function routeMessageToAntigravity(messageData, options = {}) {
  const messageId = messageData.id || crypto.randomUUID();
  const epochMs = messageData.epochMs || Date.now();
  const timestamp = messageData.timestamp || new Date().toISOString();

  // 1. Check Antigravity webview connectivity & CSRF token
  const agConfig = await getAntigravityConfig({ timeoutMs: 1500 });

  const envelope = {
    id: messageId,
    epochMs,
    timestamp,
    sender: messageData.sender || 'ex-delegate-mcp',
    recipient: 'antigravity',
    type: messageData.type || 'task_dispatch',
    priority: messageData.priority || 'NORMAL',
    payload: messageData.payload || { message: messageData.message || '' },
    metadata: {
      ...(messageData.metadata || {}),
      csrfToken: agConfig.csrfToken || undefined,
      antigravityOnline: agConfig.online
    }
  };

  const serialized = JSON.stringify(envelope, null, 2);
  const fileName = `${epochMs}_${messageId}.json`;
  const writtenPaths = [];

  // 2. Deliver to Dual Mailboxes (User home & Workspace)
  const targetDirs = getDualMailboxDirs();
  for (const dir of targetDirs) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tmpPath = path.join(dir, `.tmp_${messageId}_${Date.now()}.tmp`);
      const finalPath = path.join(dir, fileName);

      await retryNtfsOperation(async () => {
        await fs.promises.writeFile(tmpPath, serialized, 'utf8');
      });
      await retryNtfsOperation(async () => {
        await fs.promises.rename(tmpPath, finalPath);
      });

      agInboxDirCache.delete(dir);
      writtenPaths.push(finalPath);
    } catch (err) {
      // Continue to next mailbox
    }
  }

  // 3. Deliver to legacy monolithic antigravity.json if exists
  try {
    const legacyPath = path.join(MESH_DIR, 'antigravity.json');
    if (fs.existsSync(legacyPath)) {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        list.push({
          id: messageId,
          from: envelope.sender,
          message: envelope.payload.message || '',
          timestamp: envelope.timestamp,
          read: false
        });
        fs.writeFileSync(legacyPath, JSON.stringify(list, null, 2), 'utf8');
      }
    }
  } catch {}

  return {
    success: writtenPaths.length > 0,
    messageId,
    dualMailboxes: writtenPaths,
    csrfTokenPresent: Boolean(agConfig.csrfToken),
    webViewOnline: agConfig.online
  };
}

/**
 * Reads all unread discrete messages from Antigravity's dual mailboxes
 * @param {object} [options]
 * @returns {Array<object>}
 */
function readAntigravityInboxSync(options = {}) {
  const dirs = getDualMailboxDirs();
  const seenIds = new Set();
  const messages = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const dirStat = fs.statSync(dir);
      const cached = agInboxDirCache.get(dir);
      if (cached && cached.mtimeMs === dirStat.mtimeMs) {
        for (const msg of cached.messages) {
          if (!seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            messages.push(msg);
          }
        }
        continue;
      }

      const files = retryNtfsOperationSync(() => fs.readdirSync(dir));
      const dirMessages = [];
      for (const file of files) {
        if (!file.endsWith('.json') || file.startsWith('.tmp_')) continue;
        const filePath = path.join(dir, file);
        try {
          const fileStat = fs.statSync(filePath);
          const cachedFile = agFileCache.get(filePath);
          let parsed;
          if (cachedFile && cachedFile.mtimeMs === fileStat.mtimeMs) {
            parsed = cachedFile.message;
          } else {
            const content = retryNtfsOperationSync(() => fs.readFileSync(filePath, 'utf8'));
            parsed = JSON.parse(content);
            if (agFileCache.size > 2000) {
              const oldest = agFileCache.keys().next().value;
              agFileCache.delete(oldest);
            }
            agFileCache.set(filePath, { mtimeMs: fileStat.mtimeMs, message: parsed });
          }
          if (parsed && parsed.id) {
            dirMessages.push(parsed);
            if (!seenIds.has(parsed.id)) {
              seenIds.add(parsed.id);
              messages.push(parsed);
            }
          }
        } catch {}
      }
      agInboxDirCache.set(dir, { mtimeMs: dirStat.mtimeMs, messages: dirMessages });
    } catch {}
  }

  messages.sort((a, b) => (a.epochMs || 0) - (b.epochMs || 0));
  return messages;
}

/**
 * Automatically synchronizes message envelopes between Antigravity's dual mailboxes
 * (global user inbox and local workspace inbox), ensuring bidirectional zero-loss parity.
 * 
 * @param {object} [options]
 * @returns {Promise<{
 *   syncedCount: number,
 *   copiedToWorkspace: number,
 *   copiedToGlobal: number,
 *   files: string[]
 * }>}
 */
async function syncDualMailboxes(options = {}) {
  const dirs = getDualMailboxDirs();
  const report = {
    syncedCount: 0,
    copiedToWorkspace: 0,
    copiedToGlobal: 0,
    files: []
  };

  if (dirs.length < 2) {
    return report;
  }

  const [globalDir, workspaceDir] = dirs;

  // Ensure directories exist
  if (!fs.existsSync(globalDir)) {
    try { await fs.promises.mkdir(globalDir, { recursive: true }); } catch {}
  }
  if (!fs.existsSync(workspaceDir)) {
    try { await fs.promises.mkdir(workspaceDir, { recursive: true }); } catch {}
  }

  // Read files from both directories
  let globalFiles = [];
  let workspaceFiles = [];

  try {
    const gList = await fs.promises.readdir(globalDir);
    globalFiles = gList.filter(f => /^\d+_[a-zA-Z0-9\-]+\.json$/.test(f));
  } catch {}

  try {
    const wList = await fs.promises.readdir(workspaceDir);
    workspaceFiles = wList.filter(f => /^\d+_[a-zA-Z0-9\-]+\.json$/.test(f));
  } catch {}

  const gSet = new Set(globalFiles);
  const wSet = new Set(workspaceFiles);

  // 1. Copy files in globalDir missing from workspaceDir
  for (const f of globalFiles) {
    if (!wSet.has(f)) {
      const src = path.join(globalDir, f);
      const dst = path.join(workspaceDir, f);
      const tmp = path.join(workspaceDir, `.tmp_sync_${Date.now()}_${f}`);
      try {
        const content = await fs.promises.readFile(src, 'utf8');
        await retryNtfsOperation(async () => {
          await fs.promises.writeFile(tmp, content, 'utf8');
        });
        await retryNtfsOperation(async () => {
          await fs.promises.rename(tmp, dst);
        });
        report.copiedToWorkspace++;
        report.syncedCount++;
        report.files.push(f);
      } catch {}
    }
  }

  // 2. Copy files in workspaceDir missing from globalDir
  for (const f of workspaceFiles) {
    if (!gSet.has(f)) {
      const src = path.join(workspaceDir, f);
      const dst = path.join(globalDir, f);
      const tmp = path.join(globalDir, `.tmp_sync_${Date.now()}_${f}`);
      try {
        const content = await fs.promises.readFile(src, 'utf8');
        await retryNtfsOperation(async () => {
          await fs.promises.writeFile(tmp, content, 'utf8');
        });
        await retryNtfsOperation(async () => {
          await fs.promises.rename(tmp, dst);
        });
        report.copiedToGlobal++;
        report.syncedCount++;
        report.files.push(f);
      } catch {}
    }
  }

  // Invalidate cache if any files synced
  if (report.syncedCount > 0) {
    agInboxDirCache.clear();
  }

  return report;
}

/**
 * Synchronous variant of dual-mailbox synchronization
 */
function syncDualMailboxesSync(options = {}) {
  const dirs = getDualMailboxDirs();
  const report = {
    syncedCount: 0,
    copiedToWorkspace: 0,
    copiedToGlobal: 0,
    files: []
  };

  if (dirs.length < 2) return report;
  const [globalDir, workspaceDir] = dirs;

  if (!fs.existsSync(globalDir)) {
    try { fs.mkdirSync(globalDir, { recursive: true }); } catch {}
  }
  if (!fs.existsSync(workspaceDir)) {
    try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch {}
  }

  let globalFiles = [];
  let workspaceFiles = [];

  try {
    globalFiles = fs.readdirSync(globalDir).filter(f => /^\d+_[a-zA-Z0-9\-]+\.json$/.test(f));
  } catch {}
  try {
    workspaceFiles = fs.readdirSync(workspaceDir).filter(f => /^\d+_[a-zA-Z0-9\-]+\.json$/.test(f));
  } catch {}

  const gSet = new Set(globalFiles);
  const wSet = new Set(workspaceFiles);

  for (const f of globalFiles) {
    if (!wSet.has(f)) {
      const src = path.join(globalDir, f);
      const dst = path.join(workspaceDir, f);
      const tmp = path.join(workspaceDir, `.tmp_sync_${Date.now()}_${f}`);
      try {
        const content = fs.readFileSync(src, 'utf8');
        retryNtfsOperationSync(() => fs.writeFileSync(tmp, content, 'utf8'));
        retryNtfsOperationSync(() => fs.renameSync(tmp, dst));
        report.copiedToWorkspace++;
        report.syncedCount++;
        report.files.push(f);
      } catch {}
    }
  }

  for (const f of workspaceFiles) {
    if (!gSet.has(f)) {
      const src = path.join(workspaceDir, f);
      const dst = path.join(globalDir, f);
      const tmp = path.join(globalDir, `.tmp_sync_${Date.now()}_${f}`);
      try {
        const content = fs.readFileSync(src, 'utf8');
        retryNtfsOperationSync(() => fs.writeFileSync(tmp, content, 'utf8'));
        retryNtfsOperationSync(() => fs.renameSync(tmp, dst));
        report.copiedToGlobal++;
        report.syncedCount++;
        report.files.push(f);
      } catch {}
    }
  }

  if (report.syncedCount > 0) {
    agInboxDirCache.clear();
  }

  return report;
}

/**
 * Starts a background periodic auto-sync daemon
 * @param {number} [intervalMs=5000] 
 * @returns {{ stop: Function }}
 */
function startAutoSyncDaemon(intervalMs = 5000) {
  const timer = setInterval(() => {
    syncDualMailboxes().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop: () => clearInterval(timer)
  };
}

module.exports = {
  getAntigravityConfig,
  getDualMailboxDirs,
  routeMessageToAntigravity,
  readAntigravityInboxSync,
  syncDualMailboxes,
  syncDualMailboxesSync,
  startAutoSyncDaemon,
  ANTIGRAVITY_DEFAULT_URL
};
