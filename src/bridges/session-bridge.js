// src/bridges/session-bridge.js - Live Stdin/Stdout Bridge for Interactive CLI Sessions
const { spawn } = require('child_process');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const readline = require('readline');
const { getMeshDir } = require('../config');
const {
  getInboxFile,
  readInbox,
  ackMessage,
  withLock,
  atomicWriteFile
} = require('../core/mesh');

const MAX_PROCESSED_MESSAGE_IDS = 2000;
const DOS_DEVICE_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$|CLOCK\$)(\..*)?$/i;

function sanitizeName(name, fallback = "default") {
  if (typeof name !== "string") return fallback;
  const safeBasename = path.basename(name.replace(/\0/g, '').replace(/\\/g, "/"));
  const clean = safeBasename.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
  if (!clean || DOS_DEVICE_REGEX.test(clean)) {
    return fallback;
  }
  return clean;
}

function trackProcessedId(processedSet, id) {
  if (!id) return;
  if (processedSet.has(id)) return;
  if (processedSet.size >= MAX_PROCESSED_MESSAGE_IDS) {
    const oldest = processedSet.values().next().value;
    if (oldest !== undefined) {
      processedSet.delete(oldest);
    }
  }
  processedSet.add(id);
}

function startSessionBridge(agentName = 'cli-agent', sessionId = 's-' + Math.random().toString(36).substring(2, 8), command = 'powershell', cmdArgs = [], options = {}) {
  const safeAgent = sanitizeName(agentName, 'cli-agent');
  const safeSession = sanitizeName(sessionId, 's-' + Math.random().toString(36).substring(2, 8));
  const fullAgentTag = `${safeAgent}#${safeSession}`;
  const meshDir = (options && options.meshDir) || getMeshDir();
  const inboxFile = getInboxFile(safeAgent, meshDir);
  const sessionInboxFile = getInboxFile(`${safeAgent}#${safeSession}`, meshDir);

  console.log(`\n=============================================================`);
  console.log(`🚀 [GLOBAL INTERCOM SESSION BRIDGE ACTIVE]`);
  console.log(`👤 Agent Tag     : ${fullAgentTag.toUpperCase()}`);
  console.log(`🆔 Session ID    : ${sessionId}`);
  console.log(`📁 Session Inbox : ${path.basename(sessionInboxFile)}`);
  console.log(`▶️  Running CLI   : ${command} ${cmdArgs.join(' ')}`);
  console.log(`=============================================================\n`);

  const child = spawn(command, cmdArgs, {
    stdio: ['pipe', process.stdout, process.stderr],
    shell: false
  });

  let closed = false;

  const safeWriteStdin = (line) => {
    if (closed || !child.stdin || typeof child.stdin.write !== 'function') return false;
    if (child.stdin.destroyed || child.stdin.writable === false) return false;
    try {
      child.stdin.write(line + '\n');
      return true;
    } catch {
      return false;
    }
  };

  if (child.stdin && typeof child.stdin.on === 'function') {
    child.stdin.on('error', (err) => {
      if (err && err.code !== 'EPIPE') {
        console.error(`[Session Bridge stdin error]: ${err.message}`);
      }
    });
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    safeWriteStdin(line);
  });

  async function checkInbox(filePath, lockKey) {
    if (!fs.existsSync(filePath)) return [];
    return await withLock(lockKey, async () => {
      try {
        const dataStr = await fsPromises.readFile(filePath, 'utf8');
        const data = JSON.parse(dataStr);
        if (!Array.isArray(data)) return [];
        const unread = data.filter(m => m && !m.read);
        if (unread.length > 0) {
          data.forEach(m => { if (m) m.read = true; });
          await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
        }
        return unread;
      } catch {
        return [];
      }
    }, { meshDir });
  }

  const processedMessageIds = new Set();
  let isPolling = false;

  const pollInterval = setInterval(async () => {
    if (closed || isPolling) return;
    isPolling = true;

    try {
      // 0. Discrete Inbox Polling (Safe-Path Mesh)
      for (const target of [fullAgentTag, safeAgent]) {
        try {
          const discreteMsgs = await readInbox(target, { meshDir });
          for (const msg of discreteMsgs) {
            if (!msg) continue;
            if (msg.id && processedMessageIds.has(msg.id)) continue;
            if (msg.id) trackProcessedId(processedMessageIds, msg.id);

            const text = (msg.payload && msg.payload.message)
              || msg.message
              || (typeof msg.payload === 'string' ? msg.payload : (msg.payload && msg.payload.text ? msg.payload.text : JSON.stringify(msg.payload || '')));

            const sender = msg.sender || msg.from || 'UNKNOWN';
            console.log(`\n⚡ [INJECTING TASK FROM ${String(sender).toUpperCase()}] ──► ${fullAgentTag}`);
            safeWriteStdin(text);

            // Acknowledge discrete message so it moves to archive
            if (msg.id) {
              try {
                await ackMessage(target, String(msg.id), { unlink: false, meshDir });
              } catch {}
            }
          }
        } catch {}
      }

      // 1. Session specific legacy fallback
      const sessionMessages = await checkInbox(sessionInboxFile, `legacy_inbox_${safeAgent}_${safeSession}`);
      sessionMessages.forEach(msg => {
        if (!msg) return;
        if (msg.id && processedMessageIds.has(msg.id)) return;
        if (msg.id) trackProcessedId(processedMessageIds, msg.id);
        const sender = msg.sender || msg.from || 'UNKNOWN';
        console.log(`\n⚡ [INJECTING TASK FROM ${String(sender).toUpperCase()}] ──► ${fullAgentTag}`);
        safeWriteStdin(msg.message || '');
      });

      // 2. Targeted general legacy fallback
      if (fs.existsSync(inboxFile)) {
        await withLock(`legacy_inbox_${safeAgent}`, async () => {
          try {
            const allMsgsStr = await fsPromises.readFile(inboxFile, 'utf8');
            const allMsgs = JSON.parse(allMsgsStr);
            if (!Array.isArray(allMsgs)) return;
            let modified = false;
            const agentLower = String(agentName || safeAgent).toLowerCase();

            allMsgs.forEach(m => {
              if (!m || m.read) return;
              const targetTo = typeof m.to === 'string' ? m.to.toLowerCase() : '';
              if (!targetTo) return;

              if (targetTo === fullAgentTag || targetTo === agentLower || targetTo === safeAgent) {
                if (targetTo === fullAgentTag || !targetTo.includes('#')) {
                  if (!m.id || !processedMessageIds.has(m.id)) {
                    if (m.id) trackProcessedId(processedMessageIds, m.id);
                    const sender = m.sender || m.from || 'UNKNOWN';
                    console.log(`\n⚡ [INJECTING TASK FROM ${String(sender).toUpperCase()}] ──► ${fullAgentTag}`);
                    safeWriteStdin(m.message || '');
                  }
                  m.read = true;
                  modified = true;
                }
              }
            });

            if (modified) {
              await atomicWriteFile(inboxFile, JSON.stringify(allMsgs, null, 2));
            }
          } catch {}
        }, { meshDir });
      }
    } finally {
      isPolling = false;
    }
  }, 1000);
  if (typeof pollInterval.unref === 'function') {
    pollInterval.unref();
  }

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollInterval);
    try { rl.close(); } catch {}
    try { process.stdin.pause(); } catch {}
  };

  child.on('error', (err) => {
    cleanup();
    console.error(`\n[Session Bridge] Child process error: ${err.message}`);
    if (options && typeof options.onError === 'function') {
      options.onError(err);
    }
  });

  child.on('close', (code) => {
    cleanup();
    console.log(`\n[Session Bridge] Process closed with exit code ${code}`);
    if (options && typeof options.onClose === 'function') {
      options.onClose(code);
    }
  });

  return {
    child,
    stop: () => {
      cleanup();
      try { child.kill('SIGTERM'); } catch {}
    }
  };
}

module.exports = { startSessionBridge, sanitizeName };

if (require.main === module) {
  const args = process.argv.slice(2);
  let agent = 'cli-agent';
  let sessionId = 's-' + Math.random().toString(36).substring(2, 8);
  let cmdIndex = args.indexOf('--');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) agent = args[i + 1].toLowerCase();
    if (args[i] === '--session' && args[i + 1]) sessionId = args[i + 1];
  }

  const commandArgs = cmdIndex !== -1 ? args.slice(cmdIndex + 1) : ['powershell'];
  startSessionBridge(agent, sessionId, commandArgs[0], commandArgs.slice(1), {
    onClose: (code) => process.exit(code ?? 0),
    onError: () => process.exit(1)
  });
}
