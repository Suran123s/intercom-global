// src/routes/router.js - Modular Router and Route Handlers for Intercom Server
const { PORT } = require('../config');
const { readInbox, checkAndMarkRead, sendChannelMessage, readChannel, listChannels, broadcastToAgents, listActiveMailboxes } = require('../core/mesh');
const { updateMessageStatus, getMessageStatus, getDlq, clearDlq } = require('../core/dlq');
const { spawnAgent } = require('../controllers/spawner');
const { generateAgentCard, processA2AMessage, getA2ATask } = require('../bridges/a2a');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', err => reject(err));
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Route Handlers
 */

// 1. A2A Agent Card Discovery
async function handleA2AAgentCard(req, res, ctx) {
  const card = generateAgentCard(ctx.host);
  sendJson(res, 200, card);
}

// 2. A2A Send Message / Create Task
async function handleA2ASendMessage(req, res, ctx) {
  try {
    const parsed = await parseJsonBody(req);
    const task = processA2AMessage(parsed, ctx.dispatchMessage);
    sendJson(res, 200, task);
  } catch (err) {
    sendError(res, 400, err.message);
  }
}

// 3. A2A Get Task Status
async function handleA2AGetTask(req, res, ctx) {
  const parts = ctx.parsedUrl.pathname.split('/');
  const taskId = parts[parts.length - 1];
  const task = getA2ATask(taskId);
  if (!task) {
    return sendError(res, 404, 'Task not found');
  }
  sendJson(res, 200, task);
}

// 3b. Peers list — all active mailboxes
async function handleGetPeers(req, res, ctx) {
  const peers = listActiveMailboxes();
  sendJson(res, 200, peers);
}

// 3c. Doctor — full mesh health probe
async function handleGetDoctor(req, res, ctx) {
  const { diagnoseMesh } = require('../controllers/autowake');
  try {
    const health = await diagnoseMesh();
    sendJson(res, 200, health);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

// 4. Server-Sent Events (SSE) Stream
async function handleEventsStream(req, res, ctx) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);
  ctx.sseClients.add(res);
  req.on('close', () => ctx.sseClients.delete(res));
}

// 5. Standard Intercom REST Send
async function handleIntercomSend(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    const { from, to, message } = body;
    if (!from || !to || !message) throw new Error('Missing from, to, or message fields');
    const msgObj = ctx.dispatchMessage(from, to, message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'delivered', to, messageId: msgObj.id, autoReply: ctx.AUTO_REPLY_ENABLED }));
  } catch (err) {
    sendError(res, 400, err.message);
  }
}

// 6. Multi-Agent Broadcast
async function handleIntercomBroadcast(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    const { from, to, message } = body;
    if (!from || !to || !message) throw new Error('Missing from, to, or message fields');
    const results = broadcastToAgents(from, to, message, ctx.dispatchMessage);
    ctx.broadcastEvent('broadcast', { from, targets: to, message, results });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'broadcast_dispatched', count: results.length, results }));
  } catch (err) {
    sendError(res, 400, err.message);
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  } catch (err) {
    sendError(res, 400, err.message);
  }
}

// 8. List Pub/Sub Channels
async function handleListChannels(req, res, ctx) {
  const channels = listChannels();
  sendJson(res, 200, channels);
}

// 9. Read Pub/Sub Channel
async function handleReadChannel(req, res, ctx) {
  const channel = ctx.parsedUrl.pathname.replace('/api/intercom/channels/', '');
  const messages = readChannel(channel);
  sendJson(res, 200, messages);
}

// 10. Read Mailbox
async function handleReadInbox(req, res, ctx) {
  const agent = ctx.parsedUrl.searchParams.get('agent');
  if (!agent) {
    return sendError(res, 400, 'agent query param required');
  }
  const unread = checkAndMarkRead(agent);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(unread));
}

// 11. Task Acknowledgment (ACK/NACK)
async function handleTaskAck(req, res, ctx) {
  try {
    const body = await parseJsonBody(req);
    const { agent, messageId, status, result } = body;
    if (!agent || !messageId) throw new Error('Missing agent or messageId');
    const updated = updateMessageStatus(agent, messageId, status || 'COMPLETED', result);
    if (!updated) {
      return sendError(res, 404, `Message #${messageId} not found for agent ${agent}`);
    }
    ctx.broadcastEvent('task_ack', updated);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
  } catch (err) {
    sendError(res, 400, err.message);
  }
}

// 12. Task Status Check
async function handleTaskStatus(req, res, ctx) {
  const parts = ctx.parsedUrl.pathname.replace('/api/intercom/status/', '').split('/');
  const [agent, messageId] = parts;
  if (!agent || !messageId) {
    return sendError(res, 400, 'Usage: /api/intercom/status/:agent/:messageId');
  }
  const status = getMessageStatus(agent, messageId);
  if (!status) {
    return sendError(res, 404, 'Message not found');
  }
  sendJson(res, 200, status);
}

// 13. Dead Letter Queue (DLQ)
async function handleGetDlq(req, res, ctx) {
  const dlq = getDlq();
  sendJson(res, 200, dlq);
}

async function handleClearDlq(req, res, ctx) {
  clearDlq();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'cleared' }));
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
    sendError(res, 400, err.message);
  }
}

/**
 * Route Definitions Table
 */
const routes = [
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
    match: pathname => pathname === '/api/intercom/send',
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
  }
];

function handleRequest(req, res, ctx) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const host = req.headers.host ? `http://${req.headers.host}` : `http://localhost:${PORT}`;
  const parsedUrl = new URL(req.url, host);

  const routeContext = {
    ...ctx,
    host,
    parsedUrl
  };

  for (const route of routes) {
    if (route.method === req.method && route.match(parsedUrl.pathname)) {
      return route.handler(req, res, routeContext);
    }
  }

  res.writeHead(404);
  res.end();
}

module.exports = {
  setCorsHeaders,
  handleRequest,
  routes
};
