// test/mesh.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { safeWriteJson, getInboxFile, readInbox, writeInbox, checkAndMarkRead, clearInbox, waitForUnread, listActiveMailboxes, getChannelFile } = require('../src/core/mesh');
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

test('getInboxFile prevents directory traversal', () => {
  // Traversal attempt
  const file1 = getInboxFile('../../secret');
  assert.ok(!file1.includes('..'));
  assert.ok(file1.endsWith('secret.json'));

  // Session traversal attempt
  const file2 = getInboxFile('../../agent#../../session');
  assert.ok(!file2.includes('..'));
  assert.ok(file2.endsWith('agent-session.json'));

  // Empty / dot traversal attempt should throw
  assert.throws(() => {
    getInboxFile('../..');
  }, /Invalid agent name/);
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

test('getInboxFile and getChannelFile prevent path traversal', () => {
  const inboxFile = getInboxFile('../../../etc/passwd');
  const resolvedMeshDir = path.resolve(MESH_DIR);
  assert.ok(path.resolve(inboxFile).startsWith(resolvedMeshDir + path.sep));

  const channelFile = getChannelFile('../../../etc/passwd');
  const resolvedChannelsDir = path.resolve(MESH_DIR, 'channels');
  assert.ok(path.resolve(channelFile).startsWith(resolvedChannelsDir + path.sep));
});

test('safeWriteJson atomically writes JSON data to file', () => {
  const tmpFile = path.join(__dirname, '../mesh/test-safewrite-' + Date.now() + '.json');
  const payload = { key: 'value', number: 42 };

  safeWriteJson(tmpFile, payload);

  assert.ok(fs.existsSync(tmpFile));
  const content = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.deepStrictEqual(content, payload);

  if (fs.existsSync(tmpFile)) {
    fs.unlinkSync(tmpFile);
  }
});
