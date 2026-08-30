// src/bridges/pi-intercom.js - Native Pi-Intercom Named Pipe & Socket IPC Bridge
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PI_PIPE_NAME, MESH_DIR } = require('../config');

function writeFrame(socket, payload) {
  try {
    const json = JSON.stringify(payload);
    const len = Buffer.byteLength(json, 'utf8');
    const buf = Buffer.allocUnsafe(4 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(json, 4, len, 'utf8');
    socket.write(buf);
  } catch (err) {
    console.error('[Pi Frame Write Error]:', err.message);
  }
}

function createFrameReader(onMessage, onError) {
  let header = Buffer.allocUnsafe(4);
  let headerBytes = 0;
  let payload = null;
  let payloadBytes = 0;
  let payloadLength = 0;

  return (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (headerBytes < 4) {
        const toCopy = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + toCopy);
        headerBytes += toCopy;
        offset += toCopy;
        if (headerBytes === 4) {
          payloadLength = header.readUInt32BE(0);
          payload = Buffer.allocUnsafe(payloadLength);
          payloadBytes = 0;
        }
      }
      if (headerBytes === 4 && offset < chunk.length) {
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
          headerBytes = 0;
          payload = null;
          payloadBytes = 0;
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
    this.name = options.name || 'antigravity';
    this.sessionId = 'ag-' + crypto.randomUUID().slice(0, 8);
    this.isDaemon = options.isDaemon || false;
    this.onFail = options.onFail || null;
    this.socket = null;
    this.connected = false;
    this.activeSessions = [];
    this.pendingReplies = new Map();
  }

  connect(onReady) {
    const targetDesc = typeof PI_PIPE_NAME === 'object' ? `${PI_PIPE_NAME.host}:${PI_PIPE_NAME.port}` : PI_PIPE_NAME;
    console.log(`\n🔌 [PI INTERCOM BRIDGE] Connecting to broker target: ${targetDesc}`);
    this.socket = connectSocket(PI_PIPE_NAME, () => {
      this.connected = true;
      console.log(`✅ [PI INTERCOM BRIDGE] Connected to Pi Intercom Broker!`);
      this.register();
      this.startMeshSyncLoop();
      if (onReady) onReady();
    });

    const reader = createFrameReader(
      (msg) => this.handleMessage(msg),
      (err) => console.error(`[Pi Intercom Parse Error]:`, err.message)
    );

    this.socket.on('data', reader);
    this.socket.on('error', (err) => {
      console.error(`[Pi Intercom Socket Notice]:`, err.message);
      if (!this.isDaemon && !this.connected) {
        console.log(`💡 Note: Pi Intercom broker is currently offline. Start Pi or run 'pi' in a terminal to launch the broker.`);
        if (this.onFail) this.onFail();
      }
    });
    this.socket.on('close', () => {
      this.connected = false;
      if (this.isDaemon) {
        console.log(`[Pi Intercom Bridge] Disconnected. Reconnecting in 3s...`);
        setTimeout(() => this.connect(onReady), 3000);
      }
    });
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
    console.log(`📝 [REGISTERED IN PI INTERCOM] Name: "${this.name}", Session: "${this.sessionId}"`);
  }

  listSessions(callback) {
    const reqId = 'req-' + Date.now();
    this.onceSessionList = callback;
    writeFrame(this.socket, { type: 'list', requestId: reqId });
  }

  sendMessage(to, text, replyTo = undefined) {
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
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
    console.log(`⚡ [SENT VIA PI INTERCOM] ──► ${to.toUpperCase()}: "${text}"`);
    return msgId;
  }

  ask(to, question, callback) {
    const msgId = this.sendMessage(to, `[QUESTION]: ${question}`);
    if (callback) {
      this.pendingReplies.set(msgId, callback);
    }
  }

  handleMessage(msg) {
    if (msg.type === 'registered') {
      console.log(`🎉 [REGISTRATION CONFIRMED] Protocol Features: ${msg.features?.join(', ') || 'OK'}`);
      this.listSessions((sessions) => {
        console.log(`\n📋 [ACTIVE PI SESSIONS ON THIS MACHINE]:`);
        sessions.forEach((s) => {
          console.log(`- 🟢 [${s.name || s.id}] (${s.model}) in ${s.cwd}`);
        });
      });
    } else if (msg.type === 'sessions') {
      this.activeSessions = msg.sessions || [];
      if (this.onceSessionList) {
        this.onceSessionList(this.activeSessions);
        this.onceSessionList = null;
      }
    } else if (msg.type === 'message') {
      const fromName = msg.from?.name || msg.from?.id || 'Unknown';
      const text = msg.message?.content?.text || '';
      const replyTo = msg.message?.replyTo;

      console.log(`\n🔔 [NATIVE PI MESSAGE RECEIVED] From ${fromName.toUpperCase()}: "${text}"`);

      if (replyTo && this.pendingReplies.has(replyTo)) {
        const handler = this.pendingReplies.get(replyTo);
        this.pendingReplies.delete(replyTo);
        handler(text, msg);
        return;
      }

      // Write to durable global mesh inbox
      const inboxFile = path.join(MESH_DIR, `${this.name.toLowerCase()}.json`);
      let inbox = [];
      try { inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8')); } catch {}
      inbox.push({
        id: Date.now(),
        from: `pi:${fromName}`,
        to: this.name,
        message: text,
        timestamp: new Date().toISOString(),
        read: false
      });
      fs.writeFileSync(inboxFile, JSON.stringify(inbox, null, 2), 'utf8');

      // Send instant native ack back over the pipe
      const ackText = `[Antigravity]: Received task "${text}". Logged to active mesh queue.`;
      this.sendMessage(fromName, ackText, msg.message?.id);
    } else if (msg.type === 'session_joined') {
      console.log(`👤 [PI PEER JOINED] ${msg.session?.name || msg.session?.id} (${msg.session?.model})`);
    } else if (msg.type === 'session_left') {
      console.log(`👋 [PI PEER LEFT] ${msg.sessionId}`);
    }
  }

  startMeshSyncLoop() {
    setInterval(() => {
      if (!this.connected) return;
      if (!fs.existsSync(MESH_DIR)) return;
      const files = fs.readdirSync(MESH_DIR);
      files.forEach((fileName) => {
        if (fileName.endsWith('.json')) {
          const filePath = path.join(MESH_DIR, fileName);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let updated = false;
            data.forEach((m) => {
              if (!m.read && m.from !== this.name && !m.from.startsWith('pi:')) {
                const target = fileName.replace('.json', '');
                this.sendMessage(target, `[From ${m.from.toUpperCase()}]: ${m.message}`);
                m.read = true;
                updated = true;
              }
            });
            if (updated) {
              fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            }
          } catch {}
        }
      });
    }, 1000);
  }
}

module.exports = {
  PiIntercomClient,
  writeFrame,
  createFrameReader
};

// Direct script execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const client = new PiIntercomClient({
    name: args.includes('--name') ? args[args.indexOf('--name') + 1] : 'antigravity'
  });
  client.connect();
}
