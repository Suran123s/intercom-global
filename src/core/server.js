// src/core/server.js - HTTP Intercom Daemon
const http = require('http');
const { exec } = require('child_process');
const { PORT, MESH_DIR } = require('../config');
const { readInbox, writeInbox, checkAndMarkRead } = require('./mesh');

const AUTO_REPLY_ENABLED = process.argv.includes('--auto-reply') || process.env.INTERCOM_AUTO_REPLY === 'true';

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

  // Instant Auto-Reply
  if (!isAutoReply && AUTO_REPLY_ENABLED && from.toLowerCase() !== to.toLowerCase()) {
    const replyText = `[Instant Ack from ${to}]: Received "${message}". Task processing.`;
    setTimeout(() => {
      dispatchMessage(to, from, replyText, true);
    }, 200);
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
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'POST' && parsedUrl.pathname === '/api/intercom/send') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { from, to, message } = JSON.parse(body);
          if (!from || !to || !message) throw new Error('Missing from, to, or message fields');
          dispatchMessage(from, to, message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'delivered', to, autoReply: AUTO_REPLY_ENABLED }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.method === 'GET' && parsedUrl.pathname === '/api/intercom/inbox') {
      const agent = parsedUrl.searchParams.get('agent');
      if (!agent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'agent query param required' }));
      }
      const unread = checkAndMarkRead(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(unread));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return server;
}

module.exports = {
  dispatchMessage,
  createServer
};
