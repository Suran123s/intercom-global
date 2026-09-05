// src/core/server.js - HTTP Intercom Daemon
const http = require('http');
const { exec } = require('child_process');
const { PORT } = require('../config');
const { readInbox, writeInbox } = require('./mesh');
const { handleRequest } = require('../routes/router');

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

function createServer() {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, {
      dispatchMessage,
      broadcastEvent,
      sseClients,
      AUTO_REPLY_ENABLED
    });
  });

  return server;
}

module.exports = {
  dispatchMessage,
  createServer
};
