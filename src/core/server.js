// src/core/server.js - HTTP Intercom Daemon (Silent, No Audio, No Unsolicited Prompts)
const http = require('http');
const { readInbox, writeInbox } = require('./mesh');
const { handleRequest, sendError } = require('../routes/router');

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
  // Silent no-op
}

function dispatchMessage(from, to, message, isAutoReply = false) {
  const timestamp = new Date().toISOString();

  const inbox = readInbox(to);
  const msgObj = { id: Date.now(), from, to, message, timestamp, read: false };
  inbox.push(msgObj);
  writeInbox(to, inbox);

  // Broadcast to all live SSE consumers
  broadcastEvent('message', msgObj);

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
  createServer,
  sendError
};
