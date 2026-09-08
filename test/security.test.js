const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { getInboxFile, getChannelFile, sanitizeName, readInbox, writeInbox } = require('../src/core/mesh');
const { PiIntercomClient } = require('../src/bridges/pi-intercom');
const { MESH_DIR } = require('../src/config');

test('sanitizeName strips directory traversal sequences and unsafe characters', () => {
  assert.strictEqual(sanitizeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeName('..\\..\\windows\\system32'), 'system32');
  assert.strictEqual(sanitizeName('../../../'), 'unknown');
  assert.strictEqual(sanitizeName('valid_agent-1'), 'valid_agent-1');
  assert.strictEqual(sanitizeName('agent/name'), 'name');
  assert.strictEqual(sanitizeName('session/id'), 'id');
});

test('getInboxFile restricts files inside MESH_DIR', () => {
  const file1 = getInboxFile('../../etc/passwd');
  assert.strictEqual(path.dirname(file1), path.resolve(MESH_DIR));
  assert.strictEqual(path.basename(file1), 'passwd.json');

  const file2 = getInboxFile('../evil_agent#../evil_session');
  assert.strictEqual(path.dirname(file2), path.resolve(MESH_DIR));
  assert.strictEqual(path.basename(file2), 'evil_agent-evil_session.json');
});

test('getChannelFile restricts files inside MESH_DIR/channels', () => {
  const CHANNELS_DIR = path.join(MESH_DIR, 'channels');
  const file = getChannelFile('../../secret');
  assert.strictEqual(path.dirname(file), path.resolve(CHANNELS_DIR));
  assert.strictEqual(path.basename(file), 'secret.json');
});

test('PiIntercomClient sanitizes agent name and incoming message sender name', () => {
  const client = new PiIntercomClient({ name: '../../malicious-agent' });
  assert.strictEqual(client.name, 'malicious-agent');

  // Test handleMessage with path traversal in msg.from.name
  const testMsg = {
    type: 'message',
    from: { name: '../../attacker' },
    message: { content: { text: 'test payload' } }
  };

  // Mock sendMessage to avoid socket errors in test
  client.sendMessage = () => {};

  client.handleMessage(testMsg);

  const inbox = readInbox('malicious-agent');
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].from, 'pi:attacker');
  assert.strictEqual(inbox[0].message, 'test payload');

  // Clean up
  const inboxPath = getInboxFile('malicious-agent');
  if (fs.existsSync(inboxPath)) {
    fs.unlinkSync(inboxPath);
  }
});
