// src/core/server.js - HTTP Intercom Daemon (Silent, No Audio, No Unsolicited Prompts)
const http = require('http');
const { writeMessageSync, migrateLegacyMailboxSync } = require('./mesh');
const { MessageEnvelope } = require('./message');
const { handleRequest, sendError } = require('../routes/router');

const AUTO_REPLY_ENABLED = process.argv.includes('--auto-reply') || process.env.INTERCOM_AUTO_REPLY === 'true';

const sseClients = new Set();
const MAX_SSE_BACKPRESSURE_BYTES = 1024 * 1024;

function broadcastEvent(type, payload) {
  const data = JSON.stringify({ type, timestamp: new Date().toISOString(), payload });
  const packet = `event: ${type}\ndata: ${data}\n\n`;
  for (const client of sseClients) {
    if (client.destroyed || client.writableEnded) {
      sseClients.delete(client);
      continue;
    }
    try {
      const ok = client.write(packet);
      if (!ok && client.writableLength > MAX_SSE_BACKPRESSURE_BYTES) {
        sseClients.delete(client);
        try { client.destroy(); } catch {}
      }
    } catch {
      sseClients.delete(client);
    }
  }
}

function notifySystem(from, to, message) {
  // Silent no-op
}

function dispatchMessage(from, to, message, isAutoReply = false) {
  // Migrate any existing legacy monolithic mailbox
  migrateLegacyMailboxSync(to);

  const envelope = MessageEnvelope.create({
    sender: from,
    recipient: to,
    type: 'task_dispatch',
    payload: { message }
  });

  writeMessageSync(to, envelope);

  const msgObj = {
    id: envelope.id,
    from,
    to,
    message,
    timestamp: envelope.timestamp,
    read: false,
    envelope: envelope.toJSON()
  };

  // Broadcast to all live SSE consumers
  broadcastEvent('message', msgObj);

  return msgObj;
}

function createServer() {
  const heartbeatTimer = setInterval(() => {
    const ping = `: ping ${Date.now()}\n\n`;
    for (const client of sseClients) {
      if (client.destroyed || client.writableEnded) {
        sseClients.delete(client);
        continue;
      }
      try {
        const ok = client.write(ping);
        if (!ok && client.writableLength > MAX_SSE_BACKPRESSURE_BYTES) {
          sseClients.delete(client);
          try { client.destroy(); } catch {}
        }
      } catch {
        sseClients.delete(client);
      }
    }
  }, 15000);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, {
      dispatchMessage,
      broadcastEvent,
      sseClients,
      AUTO_REPLY_ENABLED
    });
  });

  server.on('close', () => {
    clearInterval(heartbeatTimer);
    for (const client of sseClients) {
      try { if (!client.writableEnded) client.end(); } catch {}
      try { client.destroy(); } catch {}
    }
    sseClients.clear();
  });

  return server;
}

module.exports = {
  dispatchMessage,
  createServer,
  sendError
};
