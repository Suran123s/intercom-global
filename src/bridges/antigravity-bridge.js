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

              resolve({
                online: true,
                csrfToken: csrfToken || null,
                config: cachedConfig,
                url
              });
            } else {
              resolve({
                online: false,
                csrfToken: null,
                config: null,
                url,
                error: `HTTP ${res.statusCode}`
              });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({
          online: false,
          csrfToken: null,
          config: null,
          url,
          error: 'Connection timeout'
        });
      });

      req.on('error', (err) => {
        resolve({
          online: false,
          csrfToken: null,
          config: null,
          url,
          error: err.message
        });
      });
    } catch (err) {
      resolve({
        online: false,
        csrfToken: null,
        config: null,
        url,
        error: err.message
      });
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
      const start = Date.now();
      while (Date.now() - start < delay) {}
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
      const files = retryNtfsOperationSync(() => fs.readdirSync(dir));
      for (const file of files) {
        if (!file.endsWith('.json') || file.startsWith('.tmp_')) continue;
        const filePath = path.join(dir, file);
        try {
          const content = retryNtfsOperationSync(() => fs.readFileSync(filePath, 'utf8'));
          const parsed = JSON.parse(content);
          if (parsed && parsed.id && !seenIds.has(parsed.id)) {
            seenIds.add(parsed.id);
            messages.push(parsed);
          }
        } catch {}
      }
    } catch {}
  }

  messages.sort((a, b) => (a.epochMs || 0) - (b.epochMs || 0));
  return messages;
}

module.exports = {
  getAntigravityConfig,
  getDualMailboxDirs,
  routeMessageToAntigravity,
  readAntigravityInboxSync,
  ANTIGRAVITY_DEFAULT_URL
};
