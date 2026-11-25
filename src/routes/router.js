// src/routes/router.js - Central HTTP Router and Endpoint Dispatcher
const { getPort } = require('../config');
const { readInbox, checkAndMarkRead, sendChannelMessage, readChannel, listChannels, broadcastToAgents, listActiveMailboxes, validateAgentName } = require('../core/mesh');
const { updateMessageStatus, getMessageStatus, getDlq, clearDlq } = require('../core/dlq');
const { spawnAgent } = require('../controllers/spawner');
const { generateAgentCard, processA2AMessage, getA2ATask } = require('../bridges/a2a');

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB strict cap
const BODY_TIMEOUT_MS = 10000;

function setCorsHeaders(req, res) {
  const requestOrigin = req.headers ? req.headers.origin : null;
  const configuredOrigins = process.env.ALLOWED_ORIGINS || process.env.INTERCOM_ALLOWED_ORIGINS;

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Vary', 'Origin');

  if (configuredOrigins) {
    if (configuredOrigins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return;
    }

    const allowedList = configuredOrigins.split(',').map(o => o.trim()).filter(Boolean);
    if (requestOrigin && allowedList.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    }
  } else if (requestOrigin) {
    try {
      if (requestOrigin === 'null') {
        res.setHeader('Access-Control-Allow-Origin', 'null');
      } else {
        const originUrl = new URL(requestOrigin);
        if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1' || originUrl.hostname === '[::1]') {
          res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        }
      }
    } catch {}
  }
}

function sendError(res, err, statusCode = 400) {
  if (res.writableEnded || res.destroyed) return;
  const code = (err && Number.isInteger(err.statusCode)) ? err.statusCode : statusCode;
  const message = typeof err === 'string' ? err : (err && err.message ? err.message : 'Unknown error');
  if (!res.headersSent) {
    const headers = { 'Content-Type': 'application/json' };
    if (code === 413 || code === 408) {
      headers.Connection = 'close';
    }
    res.writeHead(code, headers);
  }
  return res.end(JSON.stringify({ error: message }));
}

function sendJson(res, statusCode, data) {
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  }
  return res.end(JSON.stringify(data, null, 2));
}

function parseJsonBody(req, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_BODY_BYTES;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : BODY_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      const err = new Error('Request body read timed out');
      err.statusCode = 408;
      try { req.destroy(); } catch {}
      fail(err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        const err = new Error(`Payload too large (exceeds ${maxBytes} bytes)`);
        err.statusCode = 413;
        try { req.pause(); } catch {}
        fail(err);
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    };

    const onError = (err) => fail(err);
    const onClose = () => {
      if (!settled && !req.complete) {
        const err = new Error('Request aborted before body completed');
        err.statusCode = 400;
        fail(err);
      }
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

// 0. Health check
async function handleHealth(req, res, ctx) {
  if (typeof ctx.getHealth === 'function') {
    const payload = await ctx.getHealth();
    return sendJson(res, 200, payload);
  }
  return sendJson(res, 200, { status: 'ONLINE', timestamp: new Date().toISOString() });
}

// 1. A2A Agent Card Discovery
async function handleA2AAgentCard(req, res, ctx) {
  try {
    const card = await generateAgentCard(ctx.host);
    sendJson(res, 200, card);
  } catch (err) {
    sendError(res, err, 500);
  }
}

// 2. A2A Send Message / Create Task
async function handleA2ASendMessage(req, res, ctx) {
  try {
    const parsed = await parseJsonBody(req);
    const task = processA2AMessage(parsed, ctx.dispatchMessage);
    sendJson(res, 200, task);
  } catch (err) {
    sendError(res, err, err.statusCode || 400);
  }
}

// 3. A2A Get Task Status
async function handleA2AGetTask(req, res, ctx) {
  try {
    const parts = ctx.parsedUrl.pathname.split('/');
    const taskId = parts[parts.length - 1];
    const task = getA2ATask(taskId);
    if (!task) {
      return sendError(res, 'Task not found', 404);
    }
    sendJson(res, 200, task);
  } catch (err) {
    sendError(res, err, 500);
  }
}

// 3b. Peers list — all active mailboxes or daemon peers
async function handleGetPeers(req, res, ctx) {
  try {
    if (typeof ctx.getPeers === 'function') {
      const peers = await ctx.getPeers();
      return sendJson(res, 200, peers);
    }
    const peers = await listActiveMailboxes();
    sendJson(res, 200, peers);
  } catch (err) {
    sendError(res, err, 500);
  }
}

// 3c. Doctor — full mesh health probe (used by web dashboard)
async function handleGetDoctor(req, res, ctx) {
  const { diagnoseMesh } = require('../controllers/autowake');
  try {
    const health = await diagnoseMesh();
    sendJson(res, 200, health);
  } catch (err) {
    sendError(res, err, 500);
  }
}

// 4. Server-Sent Events (SSE) Stream
async function handleEventsStream(req, res, ctx) {
  if (typeof ctx.handleSseConnect === 'function') {
    return ctx.handleSseConnect(req, res, ctx.parsedUrl);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);
  ctx.sseClients.add(res);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    ctx.sseClients.delete(res);
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
}

// 5. Standard Intercom REST Send
async function handleIntercomSend(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    if (typeof ctx.handleSend === 'function') {
      const result = await ctx.handleSend(body);
      return sendJson(res, 200, result);
    }
    const { from, to, message } = body;
    if (!from || !to || !message) throw new Error('Missing from, to, or message fields');
    const msgObj = ctx.dispatchMessage(from, to, message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'delivered', to, messageId: msgObj.id, autoReply: ctx.AUTO_REPLY_ENABLED }));
  } catch (err) {
    sendError(res, err, err.statusCode || 400);
  }
}

// 6. Multi-Agent Broadcast
async function handleIntercomBroadcast(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    const { from, to, message } = body;
    if (!from || !to || !message) throw new Error('Missing from, to, or message fields');
    const results = await broadcastToAgents(from, to, message, ctx.dispatchMessage);
    ctx.broadcastEvent('broadcast', { from, targets: to, message, results });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'broadcast_dispatched', count: results.length, results }));
  } catch (err) {
    sendError(res, err, err.statusCode || 400);
  }
}

// 7. Pub/Sub Channel Send
async function handleChannelSend(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    const { channel, from, message } = body;
    if (!channel || !from || !message) throw new Error('Missing channel, from, or message fields');
    const msg = sendChannelMessage(channel, from, message);
    ctx.broadcastEvent('channel_message', msg);
    sendJson(res, 200, msg);
  } catch (err) {
    sendError(res, err, err.statusCode || 400);
  }
}

// 8. List Pub/Sub Channels
async function handleListChannels(req, res, ctx) {
  try {
    const channels = listChannels();
    sendJson(res, 200, channels);
  } catch (err) {
    sendError(res, err, 500);
  }
}

// 9. Read Pub/Sub Channel
async function handleReadChannel(req, res, ctx) {
  const channel = ctx.parsedUrl.pathname.replace('/api/intercom/channels/', '');
  try {
    const messages = readChannel(channel);
    sendJson(res, 200, messages);
  } catch (err) {
    sendError(res, err, 400);
  }
}

// 10. Read Mailbox
async function handleReadInbox(req, res, ctx) {
  const agent = ctx.parsedUrl.searchParams.get('agent');
  if (!agent) {
    return sendError(res, 'agent query param required', 400);
  }
  try {
    const unread = checkAndMarkRead(agent);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(unread));
  } catch (err) {
    sendError(res, err, 400);
  }
}

// 11. Task Acknowledgment (ACK/NACK)
async function handleTaskAck(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    const { agent, messageId, status, result } = body;
    if (!agent || !messageId) throw new Error('Missing agent or messageId');
    const updated = updateMessageStatus(agent, messageId, status || 'COMPLETED', result);
    if (!updated) {
      return sendError(res, `Message #${messageId} not found for agent ${agent}`, 404);
    }
    ctx.broadcastEvent('task_ack', updated);
    sendJson(res, 200, updated);
  } catch (err) {
    sendError(res, err, err.statusCode || 400);
  }
}

// 12. Task Status Check
async function handleTaskStatus(req, res, ctx) {
  try {
    const parts = ctx.parsedUrl.pathname.replace('/api/intercom/status/', '').split('/');
    const [agent, messageId] = parts;
    if (!agent || !messageId) {
      return sendError(res, 'Usage: /api/intercom/status/:agent/:messageId', 400);
    }
    const status = getMessageStatus(agent, messageId);
    if (!status) {
      return sendError(res, 'Message not found', 404);
    }
    sendJson(res, 200, status);
  } catch (err) {
    sendError(res, err, err.name === 'SecurityError' ? 400 : 500);
  }
}

// 13. Dead Letter Queue (DLQ)
async function handleGetDlq(req, res, ctx) {
  try {
    const dlq = getDlq();
    sendJson(res, 200, dlq);
  } catch (err) {
    sendError(res, err, 500);
  }
}

async function handleClearDlq(req, res, ctx) {
  try {
    clearDlq();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'cleared' }));
  } catch (err) {
    sendError(res, err, 500);
  }
}

// 14. Auto-Spawn Agent
async function handleSpawnAgent(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    const { agent, visible, timeoutMs } = body;
    if (!agent) throw new Error('Missing agent field');
    const result = await spawnAgent(agent, { visible, timeoutMs });
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    sendError(res, err, err.statusCode || 400);
  }
}

// 15. Prometheus Metrics Exporter
async function handleGetMetrics(req, res, ctx) {
  try {
    const { metrics } = require('../core/metrics');
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(metrics.formatPrometheus());
  } catch (err) {
    sendError(res, err, 500);
  }
}

// 16. Interrupt Agent
async function handleInterrupt(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    if (typeof ctx.handleInterrupt === 'function') {
      const result = await ctx.handleInterrupt(body);
      return sendJson(res, 200, result);
    }
    const agent = body.agent || body.target;
    const reason = body.reason || 'User requested immediate interruption';
    const cleanAgent = validateAgentName(agent);
    const interrupter = require('../core/interrupter');
    const details = await interrupter.interruptAgent(cleanAgent, reason, {
      mode: 'mesh',
      ...(body.options || {}),
      skipHttp: true
    });
    return sendJson(res, 200, { status: 'INTERRUPTED', fastPathSseNotified: false, details });
  } catch (err) {
    sendError(res, err, err.statusCode || (err.name === 'SecurityError' ? 400 : 500));
  }
}

// 17. Graceful Daemon Shutdown
async function handleShutdown(req, res, ctx) {
  sendJson(res, 200, { status: 'SHUTTING_DOWN', message: 'Intercom daemon stopping gracefully' });
  if (typeof ctx.onShutdown === 'function') {
    const timer = setTimeout(() => {
      Promise.resolve(ctx.onShutdown()).catch(() => {});
    }, 50);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

/**
 * Route Definitions Table
 */
const routes = [
  {
    method: 'GET',
    match: pathname => pathname === '/health' || pathname === '/api/intercom/health',
    handler: handleHealth
  },
  {
    method: 'GET',
    match: pathname => pathname === '/.well-known/agent.json' || pathname === '/a2a/agent-card' || pathname === '/a2a/v1/agent-card',
    handler: handleA2AAgentCard
  },
  {
    method: 'POST',
    match: pathname => pathname === '/a2a/sendMessage' || pathname === '/a2a/v1/sendMessage' || pathname === '/a2a/tasks',
    handler: handleA2ASendMessage
  },
  {
    method: 'GET',
    match: pathname => pathname.startsWith('/a2a/tasks/') || pathname.startsWith('/a2a/v1/tasks/'),
    handler: handleA2AGetTask
  },
  {
    method: 'GET',
    match: pathname => pathname === '/api/intercom/peers',
    handler: handleGetPeers
  },
  {
    method: 'GET',
    match: pathname => pathname === '/api/intercom/doctor',
    handler: handleGetDoctor
  },
  {
    method: 'GET',
    match: pathname => pathname === '/api/intercom/events' || pathname === '/api/intercom/stream',
    handler: handleEventsStream
  },
  {
    method: 'POST',
    match: pathname => pathname === '/api/intercom/send' || pathname === '/messages',
    handler: handleIntercomSend
  },
  {
    method: 'POST',
    match: pathname => pathname === '/api/intercom/broadcast',
    handler: handleIntercomBroadcast
  },
  {
    method: 'POST',
    match: pathname => pathname === '/api/intercom/channels/send',
    handler: handleChannelSend
  },
  {
    method: 'GET',
    match: pathname => pathname === '/api/intercom/channels',
    handler: handleListChannels
  },
  {
    method: 'GET',
    match: pathname => pathname.startsWith('/api/intercom/channels/'),
    handler: handleReadChannel
  },
  {
    method: 'GET',
    match: pathname => pathname === '/api/intercom/inbox',
    handler: handleReadInbox
  },
  {
    method: 'POST',
    match: pathname => pathname === '/api/intercom/ack',
    handler: handleTaskAck
  },
  {
    method: 'GET',
    match: pathname => pathname.startsWith('/api/intercom/status/'),
    handler: handleTaskStatus
  },
  {
    method: 'GET',
    match: pathname => pathname === '/api/intercom/dlq',
    handler: handleGetDlq
  },
  {
    method: 'POST',
    match: pathname => pathname === '/api/intercom/dlq/clear',
    handler: handleClearDlq
  },
  {
    method: 'POST',
    match: pathname => pathname === '/api/intercom/spawn',
    handler: handleSpawnAgent
  },
  {
    method: 'POST',
    match: pathname => pathname === '/api/intercom/interrupt',
    handler: handleInterrupt
  },
  {
    method: 'POST',
    match: pathname => pathname === '/api/intercom/shutdown',
    handler: handleShutdown
  },
  {
    method: 'GET',
    match: pathname => pathname === '/metrics' || pathname === '/api/intercom/metrics',
    handler: handleGetMetrics
  }
];

function handleRequest(req, res, ctx = {}) {
  setCorsHeaders(req, res);

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const host = req.headers && req.headers.host ? `http://${req.headers.host}` : `http://127.0.0.1:${getPort()}`;
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '/', host);
  } catch {
    return sendError(res, 'Invalid request URL', 400);
  }

  const routeContext = {
    ...ctx,
    host,
    parsedUrl
  };

  for (const route of routes) {
    if (route.method === method && route.match(parsedUrl.pathname)) {
      return Promise.resolve()
        .then(() => route.handler(req, res, routeContext))
        .catch((err) => {
          const code = (err && Number.isInteger(err.statusCode))
            ? err.statusCode
            : (err && err.name === 'SecurityError' ? 400 : 500);
          if (!res.headersSent) {
            sendError(res, err, code);
          } else {
            try { res.end(); } catch {}
          }
        });
    }
  }

  return sendJson(res, 404, { error: `Not found: ${method} ${parsedUrl.pathname}` });
}

module.exports = {
  setCorsHeaders,
  sendError,
  sendJson,
  parseJsonBody,
  handleRequest,
  routes
};
