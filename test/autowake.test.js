// test/autowake.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { wakeAgent, wakeCliAgent, wakeOpenCodeAgent, wakeHermesAgent } = require('../src/controllers/autowake');
const { getInboxFile, readInbox } = require('../src/core/mesh');

test('wakeCliAgent writes to mailbox with beep and unread status', () => {
  const agent = 'wake-test-' + Date.now();
  const file = getInboxFile(agent);

  wakeCliAgent(agent, 'Direct wake message');

  const inbox = readInbox(agent);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].message, 'Direct wake message');
  assert.strictEqual(inbox[0].read, false);

  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});

test('wakeOpenCodeAgent connects to OpenCode API server when present', async () => {
  const mockPort = 4198;
  process.env.OPENCODE_URL = `http://127.0.0.1:${mockPort}`;
  let receivedPrompt = false;

  const mockOpenCodeServer = http.createServer((req, res) => {
    if (req.url === '/session' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ id: 'sess-123' }]));
    }
    if (req.url === '/session/sess-123/prompt_async' && req.method === 'POST') {
      receivedPrompt = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => mockOpenCodeServer.listen(mockPort, r));

  await new Promise(resolve => {
    wakeOpenCodeAgent('opencode', 'Test wake task', (success) => {
      assert.strictEqual(success, true);
      assert.strictEqual(receivedPrompt, true);
      resolve();
    });
  });

  mockOpenCodeServer.close();
  delete process.env.OPENCODE_URL;
});

test('wakeHermesAgent connects to Hermes Gateway API when present', async () => {
  const mockPort = 4197;
  process.env.HERMES_URL = `http://127.0.0.1:${mockPort}`;
  let receivedChat = false;

  const mockHermesServer = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      receivedChat = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'chatcmpl-123', choices: [{ message: { content: 'Ack' } }] }));
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => mockHermesServer.listen(mockPort, r));

  await new Promise(resolve => {
    wakeHermesAgent('hermes', 'Test hermes task', (success) => {
      assert.strictEqual(success, true);
      assert.strictEqual(receivedChat, true);
      resolve();
    });
  });

  mockHermesServer.close();
  delete process.env.HERMES_URL;
});
