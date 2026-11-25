const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { dispatchMessage } = require('../src/core/server');
const { readInbox, getInboxDir } = require('../src/core/mesh');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('Improvement #21: dispatchMessage writes discrete atomic messages', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-srv-disc-');
  const recipient = 'server_discrete_' + Date.now();
  const inboxDir = getInboxDir(recipient);

  const msg = dispatchMessage('operator', recipient, 'Test discrete message from server');
  assert.ok(msg.id);
  assert.strictEqual(msg.from, 'operator');
  assert.strictEqual(msg.to, recipient);

  const files = fs.readdirSync(inboxDir);
  assert.ok(files.some(f => f.includes(msg.id)));

  const inbox = await readInbox(recipient);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].message, 'Test discrete message from server');
  assert.strictEqual(inbox[0].read, false);
});
