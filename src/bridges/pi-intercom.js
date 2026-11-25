// src/bridges/pi-intercom.js - Native Pi-Intercom Named Pipe & Socket IPC Bridge
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getBrokerConnectTarget, getMeshDir, getAgentDirPath } = require('../config');
const {
  writeMessage,
  writeMessageSync,
  readInbox,
  ackMessage,
  sanitizeName,
  listActiveMailboxes,
  withLock,
  atomicWriteFile,
  getInboxFile
} = require('../core/mesh');
const { MessageEnvelope } = require('../core/message');

const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MiB strict frame cap
const DEFAULT_REPLY_TTL_MS = 5 * 60 * 1000;
const SESSION_LIST_TTL_MS = 30 * 1000;

function tryAutoSpawnPiBroker() {
  const agentDir = getAgentDirPath();
  const extensionDir = path.join(agentDir, 'npm', 'node_modules', 'pi-intercom');
  const brokerPath = path.join(extensionDir, 'broker', 'broker.ts');
  if (!fs.existsSync(brokerPath)) return false;

  try {
    const tsxCli = path.join(extensionDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const tsxLocal = path.join(extensionDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const targetTsx = fs.existsSync(tsxCli) ? tsxCli : (fs.existsSync(tsxLocal) ? tsxLocal : null);
    if (!targetTsx) return false;

    const child = require('child_process').spawn(
      process.execPath,
      [targetTsx, brokerPath],
      {
        detached: true,
        stdio: 'ignore',
        cwd: extensionDir,
        windowsHide: true
      }
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function writeFrame(socket, payload) {
  try {
    if (!socket || socket.destroyed || socket.writable === false) {
      return false;
    }
    const json = JSON.stringify(payload);
    const len = Buffer.byteLength(json, 'utf8');
    if (len === 0 || len > MAX_FRAME_SIZE) {
      throw new RangeError(`Outgoing frame size ${len} exceeds bounds (1..${MAX_FRAME_SIZE})`);
    }
    const buf = Buffer.alloc(4 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(json, 4, len, 'utf8');
    socket.write(buf);
    return true;
  } catch (err) {
    console.error('[Pi Frame Write Error]:', err.message);
    return false;
  }
}

function createFrameReader(onMessage, onError) {
  let header = Buffer.alloc(4);
  let headerBytes = 0;
  let payload = null;
  let payloadBytes = 0;
  let payloadLength = 0;

  const reset = () => {
    headerBytes = 0;
    payload = null;
    payloadBytes = 0;
    payloadLength = 0;
  };

  return (chunk) => {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (headerBytes < 4) {
        const toCopy = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + toCopy);
        headerBytes += toCopy;
        offset += toCopy;
        if (headerBytes === 4) {
          payloadLength = header.readUInt32BE(0);
          if (payloadLength === 0 || payloadLength > MAX_FRAME_SIZE) {
            const invalidLen = payloadLength;
            reset();
            if (onError) {
              onError(new RangeError(`Invalid frame length: ${invalidLen} (allowed 1..${MAX_FRAME_SIZE})`));
            }
            return;
          }
          payload = Buffer.alloc(payloadLength);
          payloadBytes = 0;
        }
      }
      if (headerBytes === 4 && offset < chunk.length && payload) {
        const toCopy = Math.min(payloadLength - payloadBytes, chunk.length - offset);
        chunk.copy(payload, payloadBytes, offset, offset + toCopy);
        payloadBytes += toCopy;
        offset += toCopy;
        if (payloadBytes === payloadLength) {
          try {
            const msg = JSON.parse(payload.toString('utf8'));
            onMessage(msg);
          } catch (err) {
            if (onError) onError(err);
          }
          reset();
        }
      }
    }
  };
}

function connectSocket(target, connectListener) {
  if (typeof target === 'object' && target !== null && target.host && target.port) {
    return net.connect({ host: target.host, port: target.port }, connectListener);
  }
  return net.connect(target, connectListener);
}

class PiIntercomClient {
  constructor(options = {}) {
    this.name = sanitizeName(options.name || 'antigravity');
    this.sessionId = 'ag-' + crypto.randomUUID().slice(0, 8);
    this.isDaemon = Boolean(options.isDaemon);
    this.onFail = options.onFail || null;
    this.logger = typeof options.logger === 'function' ? options.logger : (...args) => console.error(...args);
    this.replyTtlMs = Number.isFinite(options.replyTtlMs) && options.replyTtlMs > 0 ? options.replyTtlMs : DEFAULT_REPLY_TTL_MS;
    this.socket = null;
    this.connected = false;
    this.manuallyDisconnected = false;
    this.activeSessions = [];
    this.pendingReplies = new Map();
    this.pendingSessionRequests = new Map();
    this.spawnAttempted = false;
    this.reconnectTimer = null;
    this.syncInterval = null;
    this.isSyncing = false;
  }

  _log(...args) {
    try {
      this.logger(...args);
    } catch {}
  }

  _pruneExpiredCallbacks() {
    const now = Date.now();
    for (const [id, entry] of this.pendingReplies.entries()) {
      if (entry.expiresAt <= now) {
        this.pendingReplies.delete(id);
      }
    }
    for (const [reqId, entry] of this.pendingSessionRequests.entries()) {
      if (entry.expiresAt <= now) {
        this.pendingSessionRequests.delete(reqId);
      }
    }
  }

  _scheduleReconnect(delayMs, onReady) {
    if (this.manuallyDisconnected || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manuallyDisconnected) {
        this.connect(onReady);
      }
    }, delayMs);
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  _destroySocket() {
    if (!this.socket) return;
    try {
      this.socket.removeAllListeners();
      this.socket.destroy();
    } catch {}
    this.socket = null;
    this.connected = false;
  }

  connect(onReady) {
    this.manuallyDisconnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._destroySocket();

    const target = getBrokerConnectTarget();
    const targetDesc = typeof target === 'object' ? `${target.host}:${target.port}` : target;
    this._log(`\n🔌 [PI INTERCOM BRIDGE] Connecting to broker target: ${targetDesc}`);

    let spawnRetryScheduled = false;
    const sock = connectSocket(target, () => {
      this.connected = true;
      this._log(`✅ [PI INTERCOM BRIDGE] Connected to Pi Intercom Broker!`);
      this.register();
      this.startMeshSyncLoop();
      if (onReady) onReady();
    });
    this.socket = sock;

    const reader = createFrameReader(
      (msg) => this.handleMessage(msg),
      (err) => {
        this._log(`[Pi Intercom Parse Error]:`, err.message);
        if (err instanceof RangeError && sock && !sock.destroyed) {
          sock.destroy();
        }
      }
    );

    sock.on('data', reader);
    sock.on('error', (err) => {
      this._log(`[Pi Intercom Socket Notice]:`, err.message);
      if (!this.connected && !this.spawnAttempted) {
        this.spawnAttempted = true;
        const spawned = tryAutoSpawnPiBroker();
        if (spawned) {
          spawnRetryScheduled = true;
          this._log(`🚀 [PI INTERCOM BRIDGE] Auto-spawning background Pi Intercom Broker... Retrying in 1s`);
          this._scheduleReconnect(1000, onReady);
          return;
        }
      }
      if (!this.isDaemon && !this.connected) {
        this._log(`💡 Note: Pi Intercom broker is currently offline. Start Pi or run 'pi' in a terminal to launch the broker.`);
        if (this.onFail) this.onFail();
      }
    });
    sock.on('close', () => {
      this.connected = false;
      if (this.socket === sock) {
        this.socket = null;
      }
      if (this.manuallyDisconnected || spawnRetryScheduled) return;
      if (this.isDaemon) {
        this._log(`[Pi Intercom Bridge] Disconnected. Reconnecting in 3s...`);
        this._scheduleReconnect(3000, onReady);
      }
    });
  }

  disconnect() {
    this.manuallyDisconnected = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this._destroySocket();
    this.pendingReplies.clear();
    this.pendingSessionRequests.clear();
  }

  register() {
    const reg = {
      type: 'register',
      protocolVersion: 1,
      session: {
        id: this.sessionId,
        name: this.name,
        cwd: process.cwd(),
        model: 'gemini-2.5-pro (Antigravity)',
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        status: 'idle'
      }
    };
    writeFrame(this.socket, reg);
    this._log(`📝 [REGISTERED IN PI INTERCOM] Name: "${this.name}", Session: "${this.sessionId}"`);
  }

  listSessions(callback) {
    this._pruneExpiredCallbacks();
    const reqId = `req-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
    if (typeof callback === 'function') {
      this.pendingSessionRequests.set(reqId, {
        callback,
        expiresAt: Date.now() + SESSION_LIST_TTL_MS
      });
    }
    writeFrame(this.socket, { type: 'list', requestId: reqId });
    return reqId;
  }

  sendMessage(to, text, replyTo = undefined) {
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      type: 'send',
      to: to,
      message: {
        id: msgId,
        timestamp: Date.now(),
        ...(replyTo ? { replyTo } : {}),
        content: { text }
      }
    };
    writeFrame(this.socket, payload);
    this._log(`⚡ [SENT VIA PI INTERCOM] ──► ${String(to || '').toUpperCase()}: "${text}"`);
    return msgId;
  }

  ask(to, question, callback) {
    this._pruneExpiredCallbacks();
    const msgId = this.sendMessage(to, `[QUESTION]: ${question}`);
    if (typeof callback === 'function') {
      this.pendingReplies.set(msgId, {
        callback,
        expiresAt: Date.now() + this.replyTtlMs
      });
    }
    return msgId;
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    this._pruneExpiredCallbacks();

    if (msg.type === 'registered') {
      this._log(`🎉 [REGISTRATION CONFIRMED] Protocol Features: ${msg.features?.join(', ') || 'OK'}`);
      this.listSessions((sessions) => {
        this._log(`\n📋 [ACTIVE PI SESSIONS ON THIS MACHINE]:`);
        sessions.forEach((s) => {
          this._log(`- 🟢 [${s.name || s.id}] (${s.model}) in ${s.cwd}`);
        });
      });
    } else if (msg.type === 'sessions') {
      this.activeSessions = msg.sessions || [];
      if (msg.requestId && this.pendingSessionRequests.has(msg.requestId)) {
        const entry = this.pendingSessionRequests.get(msg.requestId);
        this.pendingSessionRequests.delete(msg.requestId);
        entry.callback(this.activeSessions);
      } else if (!msg.requestId && this.pendingSessionRequests.size > 0) {
        const oldestKey = this.pendingSessionRequests.keys().next().value;
        const entry = this.pendingSessionRequests.get(oldestKey);
        this.pendingSessionRequests.delete(oldestKey);
        entry.callback(this.activeSessions);
      }
    } else if (msg.type === 'message') {
      const rawFromName = msg.from?.name || msg.from?.id || 'Unknown';
      const fromName = sanitizeName(rawFromName);
      const text = msg.message?.content?.text || '';
      const replyTo = msg.message?.replyTo;

      this._log(`\n🔔 [NATIVE PI MESSAGE RECEIVED] From ${fromName.toUpperCase()}: "${text}"`);

      if (replyTo && this.pendingReplies.has(replyTo)) {
        const entry = this.pendingReplies.get(replyTo);
        this.pendingReplies.delete(replyTo);
        if (entry.expiresAt > Date.now()) {
          entry.callback(text, msg);
          return;
        }
      }

      // Persist to discrete global mesh inbox synchronously for immediate reader consistency
      const envelope = new MessageEnvelope({
        sender: `pi:${fromName}`,
        recipient: this.name,
        type: 'task_dispatch',
        payload: { message: text },
        metadata: { source: 'pi-intercom', piSender: fromName }
      });
      writeMessageSync(this.name, envelope);

      // Send instant native ack back over the pipe
      const ackText = `[Antigravity]: Received task "${text}". Logged to active mesh queue.`;
      this.sendMessage(fromName, ackText, msg.message?.id);
    } else if (msg.type === 'session_joined') {
      this._log(`👤 [PI PEER JOINED] ${msg.session?.name || msg.session?.id} (${msg.session?.model})`);
    } else if (msg.type === 'session_left') {
      this._log(`👋 [PI PEER LEFT] ${msg.sessionId}`);
    }
  }

  startMeshSyncLoop() {
    if (this.syncInterval) return;
    this.syncInterval = setInterval(async () => {
      if (!this.connected || this.manuallyDisconnected) return;
      if (this.isSyncing) return;
      this.isSyncing = true;
      try {
        const meshDir = getMeshDir();
        const mailboxes = await listActiveMailboxes({ excludeEphemeral: false, meshDir });
        for (const mailbox of mailboxes) {
          const target = mailbox && mailbox.name;
          if (!target) continue;
          try {
            const messages = await readInbox(target, { meshDir });
            const legacyAckIds = new Set();

            for (const m of messages) {
              if (!m || m.read) continue;
              const rawSender = m.sender || m.from;
              if (typeof rawSender !== 'string' || !rawSender.trim()) continue;
              const sender = rawSender.trim();
              if (sender === this.name || sender.startsWith('pi:')) continue;

              const text = m.message
                || (m.payload && (m.payload.message || m.payload.text))
                || (typeof m.payload === 'string' ? m.payload : '');
              if (!text) continue;

              this.sendMessage(target, `[From ${sender.toUpperCase()}]: ${text}`);

              let acked = false;
              if (m.id) {
                try {
                  acked = await ackMessage(target, String(m.id), { unlink: false, meshDir });
                } catch {}
              }
              if (!acked && m.id !== undefined && m.id !== null) {
                legacyAckIds.add(String(m.id));
              }
            }

            if (legacyAckIds.size > 0) {
              const legacyFile = getInboxFile(target, meshDir);
              if (fs.existsSync(legacyFile)) {
                await withLock(`legacy_inbox_${sanitizeName(target)}`, async () => {
                  try {
                    const raw = await fs.promises.readFile(legacyFile, 'utf8');
                    const list = JSON.parse(raw);
                    if (Array.isArray(list)) {
                      let changed = false;
                      for (const item of list) {
                        if (item && item.id !== undefined && legacyAckIds.has(String(item.id)) && !item.read) {
                          item.read = true;
                          changed = true;
                        }
                      }
                      if (changed) {
                        await atomicWriteFile(legacyFile, JSON.stringify(list, null, 2));
                      }
                    }
                  } catch {}
                }, { meshDir });
              }
            }
          } catch {}
        }
      } catch {
      } finally {
        this.isSyncing = false;
      }
    }, 1000);
    if (typeof this.syncInterval.unref === 'function') {
      this.syncInterval.unref();
    }
  }
}

module.exports = {
  PiIntercomClient,
  writeFrame,
  createFrameReader,
  tryAutoSpawnPiBroker,
  connectSocket,
  MAX_FRAME_SIZE
};

// Direct script execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const client = new PiIntercomClient({
    name: args.includes('--name') ? args[args.indexOf('--name') + 1] : 'antigravity'
  });
  client.connect();
}
