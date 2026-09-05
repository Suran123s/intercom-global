// test/mesh.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { getInboxFile, readInbox, writeInbox, checkAndMarkRead, clearInbox, waitForUnread, listActiveMailboxes, getChannelFile } = require('../src/core/mesh');
const { MESH_DIR } = require('../src/config');

test('mesh mailbox read, write, and checkAndMarkRead', async (t) => {
  const testAgent = 'test-agent-mesh-' + Date.now();
  const file = getInboxFile(testAgent);

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

  // Cleanup test file
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});

test('getInboxFile and getChannelFile prevent path traversal', () => {
  const inboxFile = getInboxFile('../../../etc/passwd');
  const resolvedMeshDir = path.resolve(MESH_DIR);
  assert.ok(path.resolve(inboxFile).startsWith(resolvedMeshDir + path.sep));

  const channelFile = getChannelFile('../../../etc/passwd');
  const resolvedChannelsDir = path.resolve(MESH_DIR, 'channels');
  assert.ok(path.resolve(channelFile).startsWith(resolvedChannelsDir + path.sep));
});

test('waitForUnread resolves immediately if unread exists', async () => {
  const testAgent = 'test-agent-immediate-' + Date.now();
  const file = getInboxFile(testAgent);

  writeInbox(testAgent, [{ id: Date.now(), from: 'bob', to: testAgent, message: 'instant', read: false }]);

  const unread = await waitForUnread(testAgent, 1000);
  assert.strictEqual(unread.length, 1);
  assert.strictEqual(unread[0].message, 'instant');

  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});

test('waitForUnread waits and resolves upon message arrival', async () => {
  const testAgent = 'test-agent-delayed-' + Date.now();
  const file = getInboxFile(testAgent);

  const waitPromise = waitForUnread(testAgent, 3000);

  setTimeout(() => {
    writeInbox(testAgent, [{ id: Date.now(), from: 'carol', to: testAgent, message: 'delayed-hello', read: false }]);
  }, 200);

  const unread = await waitPromise;
  assert.strictEqual(unread.length, 1);
  assert.strictEqual(unread[0].message, 'delayed-hello');

  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});

test('waitForUnread times out cleanly if no message arrives', async () => {
  const testAgent = 'test-agent-timeout-' + Date.now();
  const file = getInboxFile(testAgent);

  const unread = await waitForUnread(testAgent, 300);
  assert.deepStrictEqual(unread, []);

  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});
