// test/mesh.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { safeWriteJson, getInboxFile, readInbox, writeInbox, checkAndMarkRead, clearInbox, waitForUnread, getChannelFile } = require('../src/core/mesh');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('mesh mailbox read, write, and checkAndMarkRead', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-mesh-rw-');
  const testAgent = 'test-agent-mesh-' + Date.now();

  // Initially empty
  assert.deepStrictEqual(readInbox(testAgent), []);

  // Write messages
  const msg1 = { id: 1, from: 'alice', to: testAgent, message: 'hello', read: false };
  writeInbox(testAgent, [msg1]);

  // Read back
  const readBack = readInbox(testAgent);
  assert.strictEqual(readBack.length, 1);
  assert.strictEqual(readBack[0].message, 'hello');
  assert.strictEqual(readBack[0].read, false);

  // Check and mark read
  const unread = checkAndMarkRead(testAgent);
  assert.strictEqual(unread.length, 1);
  assert.strictEqual(unread[0].message, 'hello');

  // Second check should be empty
  const secondCheck = checkAndMarkRead(testAgent);
  assert.strictEqual(secondCheck.length, 0);

  // Clear inbox
  clearInbox(testAgent);
  assert.deepStrictEqual(readInbox(testAgent), []);
});

test('getInboxFile and getChannelFile prevent path traversal', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-mesh-trav-');
  const inboxFile = getInboxFile('../../../etc/passwd');
  const resolvedMeshDir = path.resolve(meshDir);
  assert.ok(path.resolve(inboxFile).startsWith(resolvedMeshDir + path.sep));

  const channelFile = getChannelFile('../../../etc/passwd');
  const resolvedChannelsDir = path.resolve(meshDir, 'channels');
  assert.ok(path.resolve(channelFile).startsWith(resolvedChannelsDir + path.sep));
});

test('waitForUnread resolves immediately if unread exists', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-mesh-imm-');
  const testAgent = 'test-agent-immediate-' + Date.now();

  writeInbox(testAgent, [{ id: Date.now(), from: 'bob', to: testAgent, message: 'instant', read: false }]);

  const unread = await waitForUnread(testAgent, 1000);
  assert.strictEqual(unread.length, 1);
  assert.strictEqual(unread[0].message, 'instant');
});

test('waitForUnread waits and resolves upon message arrival', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-mesh-wait-');
  const testAgent = 'test-agent-delayed-' + Date.now();

  const waitPromise = waitForUnread(testAgent, 3000);

  const timer = setTimeout(() => {
    writeInbox(testAgent, [{ id: Date.now(), from: 'carol', to: testAgent, message: 'delayed-hello', read: false }]);
  }, 150);

  const unread = await waitPromise;
  clearTimeout(timer);
  assert.strictEqual(unread.length, 1);
  assert.strictEqual(unread[0].message, 'delayed-hello');
});

test('waitForUnread times out cleanly if no message arrives', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-mesh-timeout-');
  const testAgent = 'test-agent-timeout-' + Date.now();

  const unread = await waitForUnread(testAgent, 200);
  assert.deepStrictEqual(unread, []);
});

test('safeWriteJson atomically writes JSON data to file', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-mesh-safe-');
  const tmpFile = path.join(meshDir, 'test-safewrite-' + Date.now() + '.json');
  const payload = { key: 'value', number: 42 };

  safeWriteJson(tmpFile, payload);

  assert.ok(fs.existsSync(tmpFile));
  const content = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.deepStrictEqual(content, payload);
});
