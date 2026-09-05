const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../src/config');
const { getInboxFile, readInbox, writeInbox, checkAndMarkRead, clearInbox, waitForUnread, listActiveMailboxes, getChannelFile } = require('../src/core/mesh');

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

test('path traversal prevention in getInboxFile and getChannelFile', () => {
  const resolvedMeshDir = path.resolve(MESH_DIR);
  const resolvedChannelsDir = path.resolve(MESH_DIR, 'channels');

  // 1. Path traversal attempt in getInboxFile
  const evilInbox = getInboxFile('../../etc/passwd');
  assert.ok(evilInbox.startsWith(resolvedMeshDir + path.sep));
  assert.strictEqual(path.basename(evilInbox), '------etc-passwd.json');

  // 2. Session name with path traversal
  const evilSessionInbox = getInboxFile('../../etc/passwd#../../secret');
  assert.ok(evilSessionInbox.startsWith(resolvedMeshDir + path.sep));
  assert.strictEqual(path.basename(evilSessionInbox), '------etc-passwd-------secret.json');

  // 3. Path traversal attempt in getChannelFile
  const evilChannel = getChannelFile('../../etc/passwd');
  assert.ok(evilChannel.startsWith(resolvedChannelsDir + path.sep));
  assert.strictEqual(path.basename(evilChannel), '------etc-passwd.json');
});
