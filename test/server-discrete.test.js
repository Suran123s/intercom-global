const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { dispatchMessage } = require('../src/core/server');
const { readInbox, getInboxDir, clearInbox } = require('../src/core/mesh');

test('Improvement #21: dispatchMessage writes discrete atomic messages', async () => {
  const recipient = 'server_discrete_' + Date.now();
  const inboxDir = getInboxDir(recipient);

  const msg = dispatchMessage('operator', recipient, 'Test discrete message from server');
  assert.ok(msg.id);
  assert.strictEqual(msg.from, 'operator');
  assert.strictEqual(msg.to, recipient);

  // Assert discrete files exist in inbox directory
  const files = fs.readdirSync(inboxDir);
  assert.ok(files.some(f => f.includes(msg.id)));

  // Assert readInbox loads it with correct properties
  const inbox = await readInbox(recipient);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].message, 'Test discrete message from server');
  assert.strictEqual(inbox[0].read, false);

  await clearInbox(recipient);
});
