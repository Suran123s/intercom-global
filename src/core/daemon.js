// src/core/daemon.js - High-Speed Local Loopback HTTP/SSE Daemon (127.0.0.1:4150)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getPort, getMeshDir } = require('../config');
const { MessageEnvelope } = require('./message');
const { writeMessage, writeMessageSync, readInbox, validateAgentName } = require('./mesh');
const { listActiveAgents } = require('./registry');
const { handleRequest, parseJsonBody, sendError, sendJson } = require('../routes/router');

const MAX_SSE_BACKPRESSURE_BYTES = 1024 * 1024;

function getPortPidPath(port, meshDir = getMeshDir()) {
  return path.join(meshDir, `daemon.${port}.pid`);
}

function getDefaultPidPath(meshDir = getMeshDir()) {
  return path.join(meshDir, 'daemon.pid');
}

function unlinkIgnoreEnoent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

class IntercomDaemon {
  constructor(options = {}) {
    this.port = options.port !== undefined ? options.port : getPort();
    this.host = '127.0.0.1'; // Invariant: Local loopback only!
    this.server = null;
    this.sseClients = new Map(); // agentName -> Set<http.ServerResponse>
    this.pidFile = getDefaultPidPath();
    this.heartbeatTimer = null;
  }

  /**
   * Starts the loopback daemon HTTP server
   * @returns {Promise<http.Server>}
   */
  async start() {
    if (this.server) {
      return this.server;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Port collision: check if an existing daemon is healthy
          this.checkExistingDaemon()
            .then(isRunning => {
              if (isRunning) {
                const error = new Error(`Port ${this.port} is already in use by an active healthy Intercom daemon`);
                error.code = 'EADDRINUSE_HEALTHY';
                reject(error);
              } else {
                reject(err);
              }
            })
            .catch(() => reject(err));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object' && addr.port) {
          this.port = addr.port;
        }
        this.writePidFile();
        this.startHeartbeatBroadcast();
        resolve(this.server);
      });
    });
  }

  /**
   * Graceful shutdown of the daemon
   */
  async stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all active SSE streams
    for (const clientSet of this.sseClients.values()) {
      for (const res of clientSet) {
        try {
          if (!res.destroyed && !res.writableEnded) {
            res.write('event: shutdown\ndata: {"status": "DAEMON_SHUTDOWN"}\n\n');
            res.end();
          }
        } catch {}
        try { res.destroy(); } catch {}
      }
    }
    this.sseClients.clear();

    if (this.server) {
      try {
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        }
      } catch {}
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }

    this.removePidFile();
  }

  _removeSseClient(agentName, clientRes) {
    const clientSet = this.sseClients.get(agentName);
    if (!clientSet) return;
    clientSet.delete(clientRes);
    if (clientSet.size === 0) {
      this.sseClients.delete(agentName);
    }
  }

  _writeSsePacket(agentName, clientRes, packet) {
    if (!clientRes || clientRes.destroyed || clientRes.writableEnded) {
      this._removeSseClient(agentName, clientRes);
      return false;
    }
    try {
      const ok = clientRes.write(packet);
      if (!ok && clientRes.writableLength > MAX_SSE_BACKPRESSURE_BYTES) {
        this._removeSseClient(agentName, clientRes);
        try { clientRes.destroy(); } catch {}
        return false;
      }
      return true;
    } catch {
      this._removeSseClient(agentName, clientRes);
      try { clientRes.destroy(); } catch {}
      return false;
    }
  }

  broadcastEvent(type, payload) {
    const data = JSON.stringify({ type, timestamp: new Date().toISOString(), payload });
    const packet = `event: ${type}\ndata: ${data}\n\n`;
    for (const [agent, clientSet] of Array.from(this.sseClients.entries())) {
      for (const clientRes of Array.from(clientSet)) {
        this._writeSsePacket(agent, clientRes, packet);
      }
    }
  }

  /**
   * Core request dispatcher unified with central router.js
   */
  handleRequest(req, res) {
    return handleRequest(req, res, {
      AUTO_REPLY_ENABLED: false,
      sseClients: new Set(),
      getHealth: () => ({
        status: 'ONLINE',
        pid: process.pid,
        uptime: process.uptime(),
        port: this.port,
        version: '2.0.0',
        timestamp: new Date().toISOString()
      }),
      getPeers: async () => ({
        connectedPeers: Array.from(this.sseClients.keys()),
        registeredAgents: await listActiveAgents()
      }),
      handleSend: (body) => this.handleSend(body),
      handleSseConnect: (rq, rs, parsedUrl) => {
        const agentName = parsedUrl.searchParams ? parsedUrl.searchParams.get('agent') : null;
        if (!agentName) {
          sendError(rs, 'Query parameter "agent" is required', 400);
          return;
        }
        return this.handleSseConnect(agentName, rq, rs);
      },
      handleInterrupt: (body) => this.handleInterrupt(body),
      onShutdown: () => this.stop(),
      broadcastEvent: (type, payload) => this.broadcastEvent(type, payload),
      dispatchMessage: (from, to, message) => {
        const envelope = MessageEnvelope.create({
          sender: from,
          recipient: to,
          type: 'task_dispatch',
          payload: { message }
        });
        writeMessageSync(to, envelope);
        const packet = `event: message\ndata: ${JSON.stringify(envelope.toJSON())}\n\n`;
        const clientSet = this.sseClients.get(envelope.recipient);
        if (clientSet && clientSet.size > 0) {
          for (const clientRes of Array.from(clientSet)) {
            this._writeSsePacket(envelope.recipient, clientRes, packet);
          }
        }
        return {
          id: envelope.id,
          from,
          to,
          message,
          timestamp: envelope.timestamp,
          read: false,
          envelope: envelope.toJSON()
        };
      }
    });
  }

  /**
   * Handles message send with Fast-Path in-memory delivery and durable Safe-Path discrete persistence
   */
  async handleSend(body = {}) {
    let envelope;
    if (body.id && body.timestamp && body.sender && body.recipient) {
      envelope = MessageEnvelope.fromJSON(body);
    } else {
      envelope = MessageEnvelope.create({
        sender: body.sender || body.from || 'anonymous',
        recipient: body.recipient || body.to,
        type: body.type || 'task_dispatch',
        priority: body.priority || 'NORMAL',
        payload: typeof body.payload === 'object' ? body.payload : { message: body.message || '' },
        correlationId: body.correlationId || body.correlation_id,
        parentId: body.parentId || body.parent_id
      });
    }

    const recipient = envelope.recipient;
    const clientSet = this.sseClients.get(recipient);

    // Fast-Path: In-memory live delivery if recipient has active SSE stream
    let deliveredCount = 0;
    if (clientSet && clientSet.size > 0) {
      const ssePacket = `event: message\ndata: ${JSON.stringify(envelope.toJSON())}\n\n`;
      for (const clientRes of Array.from(clientSet)) {
        if (this._writeSsePacket(recipient, clientRes, ssePacket)) {
          deliveredCount++;
        }
      }
    }

    // Always persist durably to the discrete file-mesh even on Fast-Path SSE delivery
    const writeResult = await writeMessage(recipient, envelope);

    if (deliveredCount > 0) {
      return {
        status: 'DELIVERED_FAST_PATH',
        messageId: envelope.id,
        deliveredClients: deliveredCount,
        path: writeResult.path,
        envelope: envelope.toJSON()
      };
    }

    return {
      status: 'DELIVERED_SAFE_PATH',
      messageId: envelope.id,
      path: writeResult.path,
      envelope: envelope.toJSON()
    };
  }

  /**
   * Handles SSE connection registration and inbox backlog draining
   */
  async handleSseConnect(rawAgentName, req, res) {
    let agentName;
    try {
      agentName = validateAgentName(rawAgentName);
    } catch (e) {
      this.sendJson(res, 400, { error: e.message });
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Register in active clients map
    if (!this.sseClients.has(agentName)) {
      this.sseClients.set(agentName, new Set());
    }
    const clientSet = this.sseClients.get(agentName);
    clientSet.add(res);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this._removeSseClient(agentName, res);
      req.removeListener('close', cleanup);
      req.removeListener('error', cleanup);
      res.removeListener('close', cleanup);
      res.removeListener('error', cleanup);
      try { if (!res.writableEnded) res.end(); } catch {}
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    this._writeSsePacket(agentName, res, `: connected at ${new Date().toISOString()}\n\n`);

    // Drain existing pending discrete inbox messages
    try {
      const pending = await readInbox(agentName);
      for (const env of pending) {
        if (cleaned) break;
        const ok = this._writeSsePacket(
          agentName,
          res,
          `event: message\ndata: ${JSON.stringify(env.toJSON ? env.toJSON() : env)}\n\n`
        );
        if (!ok) break;
      }
    } catch {}
  }

  /**
   * Handles incoming interruption request
   */
  async handleInterrupt(body = {}) {
    const agent = body.agent || body.target;
    const reason = body.reason || 'User requested immediate interruption';
    const cleanAgent = validateAgentName(agent);

    // If connected via SSE, push real-time interrupt event immediately
    const clientSet = this.sseClients.get(cleanAgent);
    let sseNotified = false;
    if (clientSet && clientSet.size > 0) {
      const interruptPayload = JSON.stringify({
        type: 'interrupt',
        priority: 'CRITICAL',
        target: cleanAgent,
        reason,
        timestamp: new Date().toISOString()
      });
      const packet = `event: interrupt\ndata: ${interruptPayload}\n\n`;
      for (const clientRes of Array.from(clientSet)) {
        if (this._writeSsePacket(cleanAgent, clientRes, packet)) {
          sseNotified = true;
        }
      }
    }

    // Delegate to interrupter module for full 3-tier execution (prevent recursive HTTP loop)
    const interrupter = require('./interrupter');
    const interruptResult = await interrupter.interruptAgent(cleanAgent, reason, {
      mode: 'mesh',
      ...(body.options || {}),
      skipHttp: true
    });

    return {
      status: 'INTERRUPTED',
      fastPathSseNotified: sseNotified,
      details: interruptResult
    };
  }

  startHeartbeatBroadcast() {
    this.heartbeatTimer = setInterval(() => {
      const ping = `: ping ${Date.now()}\n\n`;
      for (const [agent, clientSet] of Array.from(this.sseClients.entries())) {
        for (const res of Array.from(clientSet)) {
          this._writeSsePacket(agent, res, ping);
        }
      }
    }, 15000);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  writePidFile() {
    const meshDir = getMeshDir();
    this.pidFile = getDefaultPidPath(meshDir);
    const portPidFile = getPortPidPath(this.port, meshDir);
    const payload = JSON.stringify({ pid: process.pid, port: this.port });
    try {
      fs.mkdirSync(meshDir, { recursive: true });
      fs.writeFileSync(portPidFile, payload, 'utf8');
      fs.writeFileSync(this.pidFile, payload, 'utf8');
    } catch {}
  }

  removePidFile() {
    const meshDir = getMeshDir();
    const portPidFile = getPortPidPath(this.port, meshDir);
    const defaultPidFile = getDefaultPidPath(meshDir);
    try { unlinkIgnoreEnoent(portPidFile); } catch {}
    try {
      if (fs.existsSync(defaultPidFile)) {
        const raw = fs.readFileSync(defaultPidFile, 'utf8').trim();
        let pid = parseInt(raw, 10);
        let pidPort = null;
        if (isNaN(pid)) {
          try {
            const parsed = JSON.parse(raw);
            pid = parsed.pid;
            pidPort = parsed.port;
          } catch {}
        }
        if (pid === process.pid || pidPort === this.port) {
          unlinkIgnoreEnoent(defaultPidFile);
        }
      }
    } catch {}
  }

  async checkExistingDaemon() {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/api/intercom/health',
        method: 'GET',
        timeout: 1000
      }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  readJsonBody(req) {
    return parseJsonBody(req);
  }

  sendJson(res, statusCode, data) {
    return sendJson(res, statusCode, data);
  }
}

/**
 * Starts daemon on specified port
 */
async function startDaemon(port = getPort()) {
  const daemon = new IntercomDaemon({ port });
  await daemon.start();
  return daemon;
}

function readPidData(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return null;
    if (/^\d+$/.test(content)) {
      return { pid: parseInt(content, 10), port: null };
    }
    const parsed = JSON.parse(content);
    if (parsed && Number.isInteger(parsed.pid)) {
      return { pid: parsed.pid, port: parsed.port || null };
    }
  } catch {}
  return null;
}

function requestHttpShutdown(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/intercom/shutdown',
      method: 'POST',
      timeout: timeoutMs
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops running daemon cleanly via HTTP shutdown before SIGTERM, respecting port argument
 */
async function stopDaemon(port = getPort()) {
  const meshDir = getMeshDir();
  const portPidFile = getPortPidPath(port, meshDir);
  const defaultPidFile = getDefaultPidPath(meshDir);

  const portData = readPidData(portPidFile);
  const defaultData = readPidData(defaultPidFile);
  const matchingDefault = defaultData && (!defaultData.port || defaultData.port === port) ? defaultData : null;
  const pidData = portData || matchingDefault;
  const targetPort = (pidData && pidData.port) || port;

  // 1. Attempt graceful HTTP shutdown first (critical on Windows where SIGTERM is hard TerminateProcess)
  const gracefulSent = targetPort ? await requestHttpShutdown(targetPort, 1500) : false;
  if (gracefulSent) {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (pidData && pidData.pid !== process.pid && !isPidAlive(pidData.pid)) break;
      if (pidData && pidData.pid === process.pid && !fs.existsSync(portPidFile)) break;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // 2. Fallback to SIGTERM if an external daemon process is still alive
  let killed = false;
  if (pidData && pidData.pid !== process.pid && isPidAlive(pidData.pid)) {
    try {
      process.kill(pidData.pid, 'SIGTERM');
      killed = true;
    } catch {}
  }

  try { unlinkIgnoreEnoent(portPidFile); } catch {}
  if (matchingDefault) {
    try { unlinkIgnoreEnoent(defaultPidFile); } catch {}
  }

  return Boolean(gracefulSent || killed || pidData);
}

/**
 * Queries running daemon status
 */
async function getDaemonStatus(port = getPort()) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/intercom/health',
      method: 'GET',
      timeout: 1000
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ running: true, details: parsed });
        } catch {
          resolve({ running: true, details: null });
        }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => { req.destroy(); resolve({ running: false }); });
    req.end();
  });
}

module.exports = {
  IntercomDaemon,
  startDaemon,
  stopDaemon,
  getDaemonStatus
};
