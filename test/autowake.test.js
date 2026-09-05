// test/autowake.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const { wakeCliAgent, wakeOpenCodeAgent, wakeHermesAgent } = require('../src/controllers/autowake');
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

  await new Promise(r => mockOpenCodeServer.listen(0, '127.0.0.1', r));
  const port = mockOpenCodeServer.address().port;
  process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;

  await new Promise(resolve => {
    wakeOpenCodeAgent('opencode', 'Test wake task', (result) => {
      assert.strictEqual(result.delivered, true);
      assert.strictEqual(result.session, 'sess-123');
      assert.strictEqual(receivedPrompt, true);
      resolve();
    });
  });

  await new Promise(r => mockOpenCodeServer.close(r));
  delete process.env.OPENCODE_URL;
});

test('wakeHermesAgent connects to Hermes Gateway API when present', async () => {
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

  await new Promise(r => mockHermesServer.listen(0, '127.0.0.1', r));
  const port = mockHermesServer.address().port;
  process.env.HERMES_URL = `http://127.0.0.1:${port}`;

  await new Promise(resolve => {
    wakeHermesAgent('hermes', 'Test hermes task', (result) => {
      assert.strictEqual(result.delivered, true);
      assert.strictEqual(receivedChat, true);
      resolve();
    });
  });

  await new Promise(r => mockHermesServer.close(r));
  delete process.env.HERMES_URL;
});
