const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { getInboxFile, getChannelFile, sanitizeName, readInbox } = require('../src/core/mesh');
const { PiIntercomClient } = require('../src/bridges/pi-intercom');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('sanitizeName strips directory traversal sequences and unsafe characters', () => {
  assert.strictEqual(sanitizeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeName('..\\..\\windows\\system32'), 'system32');
  assert.strictEqual(sanitizeName('../../../'), 'unknown');
  assert.strictEqual(sanitizeName('valid_agent-1'), 'valid_agent-1');
  assert.strictEqual(sanitizeName('agent/name'), 'name');
  assert.strictEqual(sanitizeName('session/id'), 'id');
});

test('getInboxFile restricts files inside MESH_DIR', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-sec-inbox-');
  const file1 = getInboxFile('../../etc/passwd');
  assert.strictEqual(path.dirname(file1), path.resolve(meshDir));
  assert.strictEqual(path.basename(file1), 'passwd.json');

  const file2 = getInboxFile('../evil_agent#../evil_session');
  assert.strictEqual(path.dirname(file2), path.resolve(meshDir));
  assert.strictEqual(path.basename(file2), 'evil_agent-evil_session.json');
});

test('getChannelFile restricts files inside MESH_DIR/channels', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-sec-chan-');
  const CHANNELS_DIR = path.join(meshDir, 'channels');
  const file = getChannelFile('../../secret');
  assert.strictEqual(path.dirname(file), path.resolve(CHANNELS_DIR));
  assert.strictEqual(path.basename(file), 'secret.json');
});

test('PiIntercomClient sanitizes agent name and incoming message sender name', (t) => {
  withIsolatedMeshEnv(t, 'intercom-sec-pi-');
  const client = new PiIntercomClient({ name: '../../malicious-agent' });
  assert.strictEqual(client.name, 'malicious-agent');

  const testMsg = {
    type: 'message',
    from: { name: '../../attacker' },
    message: { content: { text: 'test payload' } }
  };

  client.sendMessage = () => {};
  client.handleMessage(testMsg);

  const inbox = readInbox('malicious-agent');
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].from, 'pi:attacker');
  assert.strictEqual(inbox[0].message, 'test payload');
});
