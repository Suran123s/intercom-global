// test/a2a.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateAgentCard, processA2AMessage, getA2ATask } = require('../src/bridges/a2a');
const { createServer, dispatchMessage } = require('../src/core/server');
const { getInboxFile } = require('../src/core/mesh');

test('A2A Agent Card generation contains required A2A schema fields', () => {
  const card = generateAgentCard('http://localhost:4150');
  assert.strictEqual(card.name, 'Intercom Global Mesh Coordinator');
  assert.strictEqual(card.version, '1.0.0');
  assert.strictEqual(card.protocolVersion, '1.0');
  assert.ok(Array.isArray(card.supportedInterfaces));
  assert.ok(Array.isArray(card.skills));
  assert.ok(card.skills.some(s => s.id === 'universal-mesh-relay'));
});

test('A2A processA2AMessage creates valid task record', () => {
  const testAgent = 'a2a-test-' + Date.now();
  const file = getInboxFile(testAgent);

  const payload = {
    sender: 'a2a-client-1',
    recipient: testAgent,
    message: {
      content: {
        text: 'A2A task payload'
      }
    }
  };

  const task = processA2AMessage(payload, dispatchMessage);
  assert.ok(task.taskId.startsWith('task-'));
  assert.strictEqual(task.status, 'SUBMITTED');
  assert.strictEqual(task.recipient, testAgent);
  assert.strictEqual(task.sender, 'a2a-client-1');

  // Verify task is fetchable
  const retrieved = getA2ATask(task.taskId);
  assert.deepStrictEqual(retrieved, task);

  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});

test('A2A HTTP endpoints: /.well-known/agent.json and /a2a/sendMessage', async (t) => {
  const server = createServer();
  const testPort = 4199;

  await new Promise((resolve) => server.listen(testPort, resolve));

  const testAgent = 'a2a-http-' + Date.now();
  const file = getInboxFile(testAgent);

  // 1. GET /.well-known/agent.json
  const cardResponse = await fetch(`http://localhost:${testPort}/.well-known/agent.json`);
  assert.strictEqual(cardResponse.status, 200);
  const cardJson = await cardResponse.json();
  assert.strictEqual(cardJson.name, 'Intercom Global Mesh Coordinator');

  // 2. POST /a2a/sendMessage
  const msgResponse = await fetch(`http://localhost:${testPort}/a2a/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: 'remote-agent',
      recipient: testAgent,
      message: { content: { text: 'Hello via A2A HTTP' } }
    })
  });
  assert.strictEqual(msgResponse.status, 200);
  const msgJson = await msgResponse.json();
  assert.strictEqual(msgJson.status, 'SUBMITTED');
  assert.ok(msgJson.taskId);

  // 3. GET /a2a/tasks/:taskId
  const taskResponse = await fetch(`http://localhost:${testPort}/a2a/tasks/${msgJson.taskId}`);
  assert.strictEqual(taskResponse.status, 200);
  const taskJson = await taskResponse.json();
  assert.strictEqual(taskJson.taskId, msgJson.taskId);
  assert.strictEqual(taskJson.status, 'SUBMITTED');

  server.close();
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});

test('sendError helper correctly formats error responses', () => {
  const { sendError } = require('../src/core/server');
  let status = null;
  let contentType = null;
  let body = null;
  const res = {
    writeHead(s, h) {
      status = s;
      contentType = h['Content-Type'];
    },
    end(b) {
      body = b;
    }
  };

  sendError(res, new Error('Invalid parameter'), 400);
  assert.strictEqual(status, 400);
  assert.strictEqual(contentType, 'application/json');
  assert.deepStrictEqual(JSON.parse(body), { error: 'Invalid parameter' });

  sendError(res, 'Not found error', 404);
  assert.strictEqual(status, 404);
  assert.deepStrictEqual(JSON.parse(body), { error: 'Not found error' });
});
