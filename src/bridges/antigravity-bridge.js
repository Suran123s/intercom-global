// src/bridges/antigravity-bridge.js - Google Antigravity Web UI & Multi-Mailbox Bridge
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getMeshDir } = require('../config');
const {
  retryNtfsOperation,
  retryNtfsOperationSync,
  atomicWriteFile,
  atomicWriteFileSync,
  withLock
} = require('../core/mesh');

const ANTIGRAVITY_DEFAULT_URL = process.env.ANTIGRAVITY_URL || 'https://127.0.0.1:58055/';

const CACHE_TTL_MS = 60 * 1000;
const OFFLINE_CACHE_TTL_MS = 5000;
const MAX_URL_CACHE_ENTRIES = 64;
const MAX_CONFIG_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB response cap

const configCache = new Map();
const offlineCache = new Map();

// Caches for Antigravity dual mailboxes
const agInboxDirCache = new Map();
const agFileCache = new Map();

/**
 * Custom HTTPS Agent allowing local self-signed dev certificates strictly for loopback Antigravity web UI
 */
const loopbackHttpsAgent = new https.Agent({
  rejectUnauthorized: false
});

function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function setBoundedCache(map, key, value) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= MAX_URL_CACHE_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

/**
 * Fetches Antigravity runtime web UI configuration and dynamic CSRF token
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {number} [options.timeoutMs=3000]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {Promise<{ online: boolean, csrfToken: string|null, config: object|null, url: string, error?: string }>}
 */
async function getAntigravityConfig(options = {}) {
  const rawUrl = options.url || ANTIGRAVITY_DEFAULT_URL;
  const timeoutMs = options.timeoutMs || 3000;
  const now = Date.now();

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (err) {
    return {
      online: false,
      csrfToken: null,
      config: null,
      url: rawUrl,
      error: err.message
    };
  }

  const normalizedUrl = parsedUrl.toString();

  if (!options.forceRefresh) {
    const cached = configCache.get(normalizedUrl);
    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
      return {
        online: true,
        csrfToken: cached.config.csrfToken || null,
        config: cached.config,
        url: normalizedUrl
      };
    }

    const offline = offlineCache.get(normalizedUrl);
    if (offline && (now - offline.timestamp < OFFLINE_CACHE_TTL_MS)) {
      return offline.result;
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const recordOffline = (errorMsg) => {
      const offlineRes = {
        online: false,
        csrfToken: null,
        config: null,
        url: normalizedUrl,
        error: errorMsg
      };
      setBoundedCache(offlineCache, normalizedUrl, { timestamp: Date.now(), result: offlineRes });
      finish(offlineRes);
    };

    try {
      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const defaultPort = isHttps ? 443 : 80;
      const port = parsedUrl.port ? Number(parsedUrl.port) : defaultPort;
      const reqOptions = {
        hostname: parsedUrl.hostname,
        port,
        path: `${parsedUrl.pathname || '/'}${parsedUrl.search || ''}`,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'intercom-global/2.0.0 (antigravity-bridge)'
        }
      };

      if (isHttps && isLoopbackHost(parsedUrl.hostname)) {
        reqOptions.agent = loopbackHttpsAgent;
      }

      const req = transport.get(reqOptions, (res) => {
        let rawData = '';
        let receivedBytes = 0;
        let truncated = false;

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          receivedBytes += Buffer.byteLength(chunk, 'utf8');
          if (receivedBytes > MAX_CONFIG_RESPONSE_BYTES) {
            truncated = true;
            req.destroy();
            recordOffline(`Response exceeded ${MAX_CONFIG_RESPONSE_BYTES} byte cap`);
            return;
          }
          rawData += chunk;
        });

        res.on('error', (err) => {
          recordOffline(err.message);
        });

        res.on('end', () => {
          if (truncated || settled) return;
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
            const configObj = extractedConfig || { csrfToken };
            setBoundedCache(configCache, normalizedUrl, { timestamp: Date.now(), config: configObj });
            offlineCache.delete(normalizedUrl);

            finish({
              online: true,
              csrfToken: csrfToken || null,
              config: configObj,
              url: normalizedUrl
            });
          } else {
            recordOffline(`HTTP ${res.statusCode}`);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        recordOffline('Connection timeout');
      });

      req.on('error', (err) => {
        recordOffline(err.message);
      });
    } catch (err) {
      recordOffline(err.message);
    }
  });
}

/**
 * Resolves Antigravity's dual mailbox directories:
 * 1. Configured INTERCOM_MESH_DIR (if set) or user home (~/.intercom-global/mesh/inbox/antigravity/)
 * 2. Workspace (.agents/mesh/inbox/antigravity/)
 * @returns {string[]}
 */
function getDualMailboxDirs() {
  const dirs = [];
  const configuredMeshDir = process.env.INTERCOM_MESH_DIR && process.env.INTERCOM_MESH_DIR.trim();
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';

  if (configuredMeshDir) {
    dirs.push(path.join(getMeshDir(), 'inbox', 'antigravity'));
  } else if (homeDir) {
    dirs.push(path.join(homeDir, '.intercom-global', 'mesh', 'inbox', 'antigravity'));
  } else {
    dirs.push(path.join(getMeshDir(), 'inbox', 'antigravity'));
  }

  const workspaceInbox = path.resolve(process.cwd(), '.agents', 'mesh', 'inbox', 'antigravity');
  if (!dirs.includes(workspaceInbox)) {
    dirs.push(workspaceInbox);
  }

  return dirs;
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

  // 2. Deliver to Dual Mailboxes (User home/configured mesh & Workspace)
  const targetDirs = getDualMailboxDirs();
  for (const dir of targetDirs) {
    try {
      const finalPath = path.join(dir, fileName);
      await atomicWriteFile(finalPath, serialized);
      agInboxDirCache.delete(dir);
      writtenPaths.push(finalPath);
    } catch {
      // Continue to next mailbox
    }
  }

  // 3. Deliver to legacy monolithic antigravity.json if exists (locked + atomic)
  try {
    const meshDir = getMeshDir();
    const legacyPath = path.join(meshDir, 'antigravity.json');
    if (fs.existsSync(legacyPath)) {
      await withLock('legacy_inbox_antigravity', async () => {
        if (!fs.existsSync(legacyPath)) return;
        const raw = await retryNtfsOperation(() => fs.promises.readFile(legacyPath, 'utf8'));
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          list.push({
            id: messageId,
            from: envelope.sender,
            message: envelope.payload.message || '',
            timestamp: envelope.timestamp,
            read: false
          });
          await atomicWriteFile(legacyPath, JSON.stringify(list, null, 2));
        }
      }, { meshDir });
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
        if (!file.endsWith('.json') || file.startsWith('.tmp_') || file.startsWith('.')) continue;
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

  if (!fs.existsSync(globalDir)) {
    try { await fs.promises.mkdir(globalDir, { recursive: true }); } catch {}
  }
  if (!fs.existsSync(workspaceDir)) {
    try { await fs.promises.mkdir(workspaceDir, { recursive: true }); } catch {}
  }

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
      try {
        const content = await retryNtfsOperation(() => fs.promises.readFile(src, 'utf8'));
        await atomicWriteFile(dst, content);
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
      try {
        const content = await retryNtfsOperation(() => fs.promises.readFile(src, 'utf8'));
        await atomicWriteFile(dst, content);
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
      try {
        const content = retryNtfsOperationSync(() => fs.readFileSync(src, 'utf8'));
        atomicWriteFileSync(dst, content);
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
      try {
        const content = retryNtfsOperationSync(() => fs.readFileSync(src, 'utf8'));
        atomicWriteFileSync(dst, content);
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
 * Starts a background periodic auto-sync daemon with overlap guard
 * @param {number} [intervalMs=5000]
 * @returns {{ stop: Function }}
 */
function startAutoSyncDaemon(intervalMs = 5000) {
  let isSyncing = false;
  const timer = setInterval(async () => {
    if (isSyncing) return;
    isSyncing = true;
    try {
      await syncDualMailboxes();
    } catch {
    } finally {
      isSyncing = false;
    }
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
