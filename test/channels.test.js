// test/channels.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const { sendChannelMessage, readChannel, listChannels, broadcastToAgents, getChannelFile } = require('../src/core/mesh');
const { createServer } = require('../src/core/server');
const { withIsolatedMeshEnv, listenEphemeral, closeServer, waitForCondition } = require('./helpers/isolated-env');

test('sendChannelMessage and readChannel perform atomic pub-sub', (t) => {
  withIsolatedMeshEnv(t, 'intercom-channels-pubsub-');
  const channelName = 'test-room-' + Date.now();
  const file = getChannelFile(channelName);

  const msg1 = sendChannelMessage(channelName, 'agent-a', 'First announcement');
  const msg2 = sendChannelMessage(channelName, 'agent-b', 'Second update');

  assert.strictEqual(msg1.channel, `#${channelName}`);
  assert.strictEqual(msg1.message, 'First announcement');
  assert.strictEqual(msg2.message, 'Second update');

  const history = readChannel(channelName);
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].from, 'agent-a');
  assert.strictEqual(history[1].from, 'agent-b');

  const allChannels = listChannels();
  const found = allChannels.find(c => c.name === `#${channelName}`);
  assert.ok(found);
  assert.strictEqual(found.total, 2);

  assert.ok(fs.existsSync(file));
});

test('getChannelFile prevents directory traversal', (t) => {
  withIsolatedMeshEnv(t, 'intercom-channels-trav-');
  const file1 = getChannelFile('../../secret');
  assert.ok(!file1.includes('..'));

  const file2 = getChannelFile('foo/bar');
  assert.ok(!file2.includes('foo/bar'));
});

test('broadcastToAgents dispatches to multiple recipients simultaneously', async () => {
  const dispatched = [];
  const mockDispatch = (from, to, msg) => {
    dispatched.push({ from, to, msg, id: 'msg-' + Date.now() });
    return { id: 'msg-' + Date.now() };
  };

  const results = await broadcastToAgents('coordinator', 'agent1,agent2,agent3', 'Sync codebase', mockDispatch);
  assert.strictEqual(results.length, 3);
  assert.strictEqual(dispatched.length, 3);
  assert.strictEqual(dispatched[0].to, 'agent1');
  assert.strictEqual(dispatched[1].to, 'agent2');
  assert.strictEqual(dispatched[2].to, 'agent3');
});

test('HTTP server SSE streaming and broadcast endpoints', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-channels-http-');
  const server = createServer();
  const port = await listenEphemeral(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  let sseReq = null;
  t.after(async () => {
    try { sseReq?.destroy(); } catch {}
    await closeServer(server);
  });

  // 1. Test SSE Stream
  let sseReceivedConnect = false;
  sseReq = http.get(`${baseUrl}/api/intercom/events`, (res) => {
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/event-stream');
    res.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('"connected"')) {
        sseReceivedConnect = true;
      }
    });
  });

  await waitForCondition(() => sseReceivedConnect, { timeoutMs: 2000, intervalMs: 15, label: 'SSE connected' });
  assert.strictEqual(sseReceivedConnect, true);

  // 2. Test HTTP Broadcast
  const broadcastRes = await fetch(`${baseUrl}/api/intercom/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'boss', to: 'worker1,worker2', message: 'Build project' })
  }).then(r => r.json());

  assert.strictEqual(broadcastRes.status, 'broadcast_dispatched');
  assert.strictEqual(broadcastRes.count, 2);

  // 3. Test HTTP Channel Publish & Read
  const chanPostRes = await fetch(`${baseUrl}/api/intercom/channels/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: '#qa-room', from: 'tester', message: 'All tests green' })
  }).then(r => r.json());

  assert.strictEqual(chanPostRes.channel, '#qa-room');

  const chanReadRes = await fetch(`${baseUrl}/api/intercom/channels/qa-room`).then(r => r.json());
  assert.ok(Array.isArray(chanReadRes));
  assert.strictEqual(chanReadRes.length, 1);
  assert.strictEqual(chanReadRes[0].message, 'All tests green');
});
