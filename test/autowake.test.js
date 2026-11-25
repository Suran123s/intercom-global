// test/autowake.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { wakeCliAgent, wakeOpenCodeAgent, wakeHermesAgent, wakeAgent } = require('../src/controllers/autowake');
const { readInbox } = require('../src/core/mesh');
const { withIsolatedMeshEnv, listenEphemeral, closeServer } = require('./helpers/isolated-env');

test('wakeCliAgent writes to mailbox with beep and unread status', (t) => {
  withIsolatedMeshEnv(t, 'intercom-autowake-cli-');
  const agent = 'wake-test-' + Date.now();

  wakeCliAgent(agent, 'Direct wake message');

  const inbox = readInbox(agent);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].message, 'Direct wake message');
  assert.strictEqual(inbox[0].read, false);
});

test('wakeCliAgent sanitizes targetName to prevent path traversal', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-autowake-trav-');
  const dangerousTarget = '../../traversal-test-' + Date.now();
  const res = wakeCliAgent(dangerousTarget, 'Malicious payload');

  const resolvedMeshDir = path.resolve(meshDir);
  const resolvedFile = path.resolve(res.file);

  assert.ok(resolvedFile.startsWith(resolvedMeshDir + path.sep), 'File path must be inside MESH_DIR');
});

test('wakeOpenCodeAgent connects to OpenCode API server when present', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-autowake-oc-');
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

  const port = await listenEphemeral(mockOpenCodeServer);
  const prevUrl = process.env.OPENCODE_URL;
  process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (prevUrl === undefined) delete process.env.OPENCODE_URL;
    else process.env.OPENCODE_URL = prevUrl;
    await closeServer(mockOpenCodeServer);
  });

  await new Promise(resolve => {
    wakeOpenCodeAgent('opencode', 'Test wake task', (result) => {
      assert.strictEqual(result.delivered, true);
      assert.strictEqual(result.session, 'sess-123');
      assert.strictEqual(receivedPrompt, true);
      resolve();
    });
  });
});

test('wakeHermesAgent connects to Hermes Gateway API when present', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-autowake-hermes-');
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

  const port = await listenEphemeral(mockHermesServer);
  const prevUrl = process.env.HERMES_URL;
  process.env.HERMES_URL = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (prevUrl === undefined) delete process.env.HERMES_URL;
    else process.env.HERMES_URL = prevUrl;
    await closeServer(mockHermesServer);
  });

  await new Promise(resolve => {
    wakeHermesAgent('hermes', 'Test hermes task', (result) => {
      assert.strictEqual(result.delivered, true);
      assert.strictEqual(receivedChat, true);
      resolve();
    });
  });
});

test('wakeAgent coordinates channel dispatch and invokes callback with report', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-autowake-rep-');
  const agent = 'wake-report-test-' + Date.now();

  await new Promise((resolve) => {
    wakeAgent(agent, 'Test full wake report', (report) => {
      assert.strictEqual(report.target, agent);
      assert.ok(report.timestamp);
      assert.ok(report.channels);
      assert.strictEqual(report.channels.mailbox.delivered, true);
      assert.ok(report.channels.pi);
      assert.ok(report.channels.opencode);
      assert.ok(report.channels.hermes);
      assert.ok(report.channels.cloud);
      resolve();
    });
  });
});
