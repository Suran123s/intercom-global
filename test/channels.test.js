// test/channels.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { sendChannelMessage, readChannel, listChannels, broadcastToAgents, getChannelFile } = require('../src/core/mesh');
const { createServer, dispatchMessage } = require('../src/core/server');

test('sendChannelMessage and readChannel perform atomic pub-sub', () => {
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

  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});

test('getChannelFile prevents directory traversal', () => {
  // Traversal attempt with ../
  const file1 = getChannelFile('../../secret');
  assert.ok(!file1.includes('..'));
  assert.ok(file1.endsWith('secret.json'));

  // Traversal attempt with slashes
  const file2 = getChannelFile('foo/bar');
  assert.ok(!file2.includes('foo/bar'));
  assert.ok(file2.endsWith('foobar.json'));

  // Empty / only dot traversal attempt should throw
  assert.throws(() => {
    getChannelFile('../..');
  }, /Invalid channel name/);
});

test('broadcastToAgents dispatches to multiple recipients simultaneously', () => {
  const dispatched = [];
  const mockDispatch = (from, to, msg) => {
    dispatched.push({ from, to, msg, id: 'msg-' + Date.now() });
    return { id: 'msg-' + Date.now() };
  };

  const results = broadcastToAgents('coordinator', 'agent1,agent2,agent3', 'Sync codebase', mockDispatch);
  assert.strictEqual(results.length, 3);
  assert.strictEqual(dispatched.length, 3);
  assert.strictEqual(dispatched[0].to, 'agent1');
  assert.strictEqual(dispatched[1].to, 'agent2');
  assert.strictEqual(dispatched[2].to, 'agent3');
});

test('HTTP server SSE streaming and broadcast endpoints', async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Test SSE Stream
  let sseReceivedConnect = false;
  let sseResStream = null;
  const sseReq = http.get(`${baseUrl}/api/intercom/events`, (res) => {
    sseResStream = res;
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/event-stream');
    res.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('"connected"')) {
        sseReceivedConnect = true;
      }
    });
  });

  await new Promise(r => setTimeout(r, 100));
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

  // Clean up
  if (sseResStream) sseResStream.destroy();
  sseReq.destroy();

  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  await new Promise(r => server.close(r));
  const chanFile = getChannelFile('qa-room');
  if (fs.existsSync(chanFile)) fs.unlinkSync(chanFile);
});
