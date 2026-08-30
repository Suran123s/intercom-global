// src/core/server.js - HTTP Intercom Daemon
const http = require('http');
const { exec } = require('child_process');
const { PORT, MESH_DIR } = require('../config');
const { readInbox, writeInbox, checkAndMarkRead, sendChannelMessage, readChannel, listChannels, broadcastToAgents } = require('./mesh');

const AUTO_REPLY_ENABLED = process.argv.includes('--auto-reply') || process.env.INTERCOM_AUTO_REPLY === 'true';

const sseClients = new Set();

function broadcastEvent(type, payload) {
  const data = JSON.stringify({ type, timestamp: new Date().toISOString(), payload });
  for (const client of sseClients) {
    try {
      client.write(`event: ${type}\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

function notifySystem(from, to, message) {
  if (process.platform === 'win32') {
    exec('powershell -c "[console]::beep(800, 150)"', { windowsHide: true }, () => {});
  }
}

function dispatchMessage(from, to, message, isAutoReply = false) {
  const timestamp = new Date().toISOString();
  console.log(`\n⚡ [GLOBAL INTERCOM ${timestamp.split('T')[1].slice(0, 8)}] ${from.toUpperCase()} ──► ${to.toUpperCase()}: "${message}"`);

  const inbox = readInbox(to);
  const msgObj = { id: Date.now(), from, to, message, timestamp, read: false };
  inbox.push(msgObj);
  writeInbox(to, inbox);

  if (!isAutoReply) {
    notifySystem(from, to, message);
  }

  // Broadcast to all live SSE consumers
  broadcastEvent('message', msgObj);

  // Instant Auto-Reply
  if (!isAutoReply && AUTO_REPLY_ENABLED && from.toLowerCase() !== to.toLowerCase()) {
    const replyText = `[Instant Ack from ${to}]: Received "${message}". Task processing.`;
    setTimeout(() => {
      dispatchMessage(to, from, replyText, true);
    }, 200);
  }

  // OpenCode API Trigger
  if (to.toLowerCase().startsWith('opencode') && !isAutoReply) {
    const port = process.env.OPENCODE_PORT || 4096;
    const url = process.env.OPENCODE_URL || `http://127.0.0.1:${port}`;
    fetch(`${url}/session/default/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: `[Intercom from ${from}]: ${message}` })
    }).catch(() => {});
  }

  // Hermes Gateway Trigger
  if (to.toLowerCase().startsWith('hermes') && !isAutoReply) {
    const port = process.env.HERMES_PORT || 8000;
    const url = process.env.HERMES_URL || `http://127.0.0.1:${port}`;
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes',
        messages: [{ role: 'user', content: `[Intercom from ${from}]: ${message}` }],
        stream: false
      })
    }).catch(() => {});
  }

  // Devin Cloud Trigger
  if (to.toLowerCase().startsWith('devin') && process.env.DEVIN_API_KEY) {
    console.log(`🚀 [DEVIN CLOUD] Waking up Devin API session...`);
    fetch('https://api.devin.ai/v1/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEVIN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: `[Intercom from ${from}]: ${message}` })
    }).catch(err => console.error('Devin trigger error:', err.message));
  }

  return msgObj;
}

const { generateAgentCard, processA2AMessage, getA2ATask } = require('../bridges/a2a');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

function createServer() {
  const server = http.createServer((req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const host = req.headers.host ? `http://${req.headers.host}` : `http://localhost:${PORT}`;
    const parsedUrl = new URL(req.url, host);

    // 1. A2A Agent Card Discovery
    if (req.method === 'GET' && (parsedUrl.pathname === '/.well-known/agent.json' || parsedUrl.pathname === '/a2a/agent-card' || parsedUrl.pathname === '/a2a/v1/agent-card')) {
      const card = generateAgentCard(host);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(card, null, 2));
    }

    // 2. A2A Send Message / Create Task
    if (req.method === 'POST' && (parsedUrl.pathname === '/a2a/sendMessage' || parsedUrl.pathname === '/a2a/v1/sendMessage' || parsedUrl.pathname === '/a2a/tasks')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const task = processA2AMessage(parsed, dispatchMessage);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(task, null, 2));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 3. A2A Get Task Status
    if (req.method === 'GET' && (parsedUrl.pathname.startsWith('/a2a/tasks/') || parsedUrl.pathname.startsWith('/a2a/v1/tasks/'))) {
      const parts = parsedUrl.pathname.split('/');
      const taskId = parts[parts.length - 1];
      const task = getA2ATask(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Task not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(task, null, 2));
    }

    // 4. Server-Sent Events (SSE) Multi-Client Real-Time Event Bus
    if (req.method === 'GET' && (parsedUrl.pathname === '/api/intercom/events' || parsedUrl.pathname === '/api/intercom/stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // 5. Standard Intercom REST Send
    if (req.method === 'POST' && parsedUrl.pathname === '/api/intercom/send') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { from, to, message } = JSON.parse(body);
          if (!from || !to || !message) throw new Error('Missing from, to, or message fields');
          const msgObj = dispatchMessage(from, to, message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'delivered', to, messageId: msgObj.id, autoReply: AUTO_REPLY_ENABLED }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 6. Multi-Agent Broadcast (1-to-Many Swarm)
    if (req.method === 'POST' && parsedUrl.pathname === '/api/intercom/broadcast') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { from, to, message } = JSON.parse(body);
          if (!from || !to || !message) throw new Error('Missing from, to, or message fields');
          const results = broadcastToAgents(from, to, message, dispatchMessage);
          broadcastEvent('broadcast', { from, targets: to, message, results });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'broadcast_dispatched', count: results.length, results }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 7. Pub/Sub Channel Send
    if (req.method === 'POST' && parsedUrl.pathname === '/api/intercom/channels/send') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { channel, from, message } = JSON.parse(body);
          if (!channel || !from || !message) throw new Error('Missing channel, from, or message fields');
          const msg = sendChannelMessage(channel, from, message);
          broadcastEvent('channel_message', msg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(msg));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 8. List Pub/Sub Channels
    if (req.method === 'GET' && parsedUrl.pathname === '/api/intercom/channels') {
      const channels = listChannels();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(channels, null, 2));
    }

    // 9. Read Pub/Sub Channel
    if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/intercom/channels/')) {
      const channel = parsedUrl.pathname.replace('/api/intercom/channels/', '');
      const messages = readChannel(channel);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(messages, null, 2));
    }

    // 10. Read Mailbox
    if (req.method === 'GET' && parsedUrl.pathname === '/api/intercom/inbox') {
      const agent = parsedUrl.searchParams.get('agent');
      if (!agent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'agent query param required' }));
      }
      const unread = checkAndMarkRead(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(unread));
    }

    res.writeHead(404);
    res.end();
  });

  return server;
}

module.exports = {
  dispatchMessage,
  createServer
};

