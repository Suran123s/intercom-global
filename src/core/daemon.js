// src/core/daemon.js - High-Speed Local Loopback HTTP/SSE Daemon (127.0.0.1:4150)
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { PORT, MESH_DIR } = require('../config');
const { MessageEnvelope, validateMessage } = require('./message');
const { writeMessage, readInbox, ackMessage, validateAgentName, retryNtfsOperation } = require('./mesh');
const { listActiveAgents } = require('./registry');

class IntercomDaemon {
  constructor(options = {}) {
    this.port = options.port || PORT || 4150;
    this.host = '127.0.0.1'; // Invariant: Local loopback only!
    this.server = null;
    this.sseClients = new Map(); // agentName -> Set<http.ServerResponse>
    this.pidFile = path.join(MESH_DIR, 'daemon.pid');
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
    for (const [agent, clientSet] of this.sseClients.entries()) {
      for (const res of clientSet) {
        try {
          res.write('event: shutdown\ndata: {"status": "DAEMON_SHUTDOWN"}\n\n');
          res.end();
        } catch {}
      }
    }
    this.sseClients.clear();

    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }

    this.removePidFile();
  }

  /**
   * Core request dispatcher
   */
  async handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${this.host}:${this.port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // CORS: Strictly localhost/loopback origins only
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 1. Health check
      if (pathname === '/api/intercom/health' && method === 'GET') {
        const health = {
          status: 'ONLINE',
          pid: process.pid,
          uptime: process.uptime(),
          port: this.port,
          version: '2.0.0',
          timestamp: new Date().toISOString()
        };
        this.sendJson(res, 200, health);
        return;
      }

      // 2. Connected & Registered Peers
      if (pathname === '/api/intercom/peers' && method === 'GET') {
        const connectedPeers = Array.from(this.sseClients.keys());
        const registered = await listActiveAgents();
        this.sendJson(res, 200, {
          connectedPeers,
          registeredAgents: registered
        });
        return;
      }

      // 3. Fast-Path / Safe-Path Send Endpoint
      if ((pathname === '/api/intercom/send' || pathname === '/messages') && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.handleSend(body);
        this.sendJson(res, 200, result);
        return;
      }

      // 4. SSE Real-Time Event Stream
      if (pathname === '/api/intercom/events' && method === 'GET') {
        const agentName = parsedUrl.searchParams ? parsedUrl.searchParams.get('agent') : (parsedUrl.query && parsedUrl.query.agent);
        if (!agentName) {
          this.sendJson(res, 400, { error: 'Query parameter "agent" is required' });
          return;
        }
        await this.handleSseConnect(agentName, req, res);
        return;
      }

      // 5. Interrupt Endpoint
      if (pathname === '/api/intercom/interrupt' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.handleInterrupt(body);
        this.sendJson(res, 200, result);
        return;
      }

      // 6. Graceful Shutdown Endpoint
      if (pathname === '/api/intercom/shutdown' && method === 'POST') {
        this.sendJson(res, 200, { status: 'SHUTTING_DOWN', message: 'Intercom daemon stopping gracefully' });
        setTimeout(() => this.stop(), 50);
        return;
      }

      // 404 Fallback
      this.sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      this.sendJson(res, 500, { error: err.message });
    }
  }

  /**
   * Handles message send with Fast-Path in-memory delivery and Safe-Path file-mesh fallback
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

    // Fast-Path: In-memory live delivery if recipient has active SSE/WS stream
    if (clientSet && clientSet.size > 0) {
      const ssePacket = `event: message\ndata: ${JSON.stringify(envelope.toJSON())}\n\n`;
      let deliveredCount = 0;
      for (const clientRes of clientSet) {
        try {
          clientRes.write(ssePacket);
          deliveredCount++;
        } catch {
          clientSet.delete(clientRes);
        }
      }

      if (deliveredCount > 0) {
        return {
          status: 'DELIVERED_FAST_PATH',
          messageId: envelope.id,
          deliveredClients: deliveredCount,
          envelope: envelope.toJSON()
        };
      }
    }

    // Safe-Path Fallback: Persist to discrete atomic file-mesh
    const writeResult = await writeMessage(recipient, envelope);
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
    res.write(`: connected at ${new Date().toISOString()}\n\n`);

    // Register in active clients map
    if (!this.sseClients.has(agentName)) {
      this.sseClients.set(agentName, new Set());
    }
    const clientSet = this.sseClients.get(agentName);
    clientSet.add(res);

    req.on('close', () => {
      clientSet.delete(res);
      if (clientSet.size === 0) {
        this.sseClients.delete(agentName);
      }
    });

    // Drain existing pending discrete inbox messages
    try {
      const pending = await readInbox(agentName);
      for (const env of pending) {
        res.write(`event: message\ndata: ${JSON.stringify(env.toJSON ? env.toJSON() : env)}\n\n`);
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
      for (const clientRes of clientSet) {
        try {
          clientRes.write(`event: interrupt\ndata: ${interruptPayload}\n\n`);
          sseNotified = true;
        } catch {
          clientSet.delete(clientRes);
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
      for (const [agent, clientSet] of this.sseClients.entries()) {
        for (const res of clientSet) {
          try {
            res.write(ping);
          } catch {
            clientSet.delete(res);
          }
        }
      }
    }, 15000);
  }

  writePidFile() {
    try {
      fs.writeFileSync(this.pidFile, String(process.pid), 'utf8');
    } catch {}
  }

  removePidFile() {
    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
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
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk;
        if (data.length > 10 * 1024 * 1024) { // 10MB limit
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!data.trim()) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      });
      req.on('error', reject);
    });
  }

  sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }
}

/**
 * Starts daemon on specified port
 */
async function startDaemon(port = PORT || 4150) {
  const daemon = new IntercomDaemon({ port });
  await daemon.start();
  return daemon;
}

/**
 * Stops running daemon
 */
async function stopDaemon(port = PORT || 4150) {
  const pidFile = path.join(MESH_DIR, 'daemon.pid');
  if (fs.existsSync(pidFile)) {
    try {
      const content = fs.readFileSync(pidFile, 'utf8').trim();
      let pid = parseInt(content, 10);
      if (isNaN(pid)) {
        try { pid = JSON.parse(content).pid; } catch {}
      }
      if (pid && !isNaN(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Queries running daemon status
 */
async function getDaemonStatus(port = PORT || 4150) {
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
