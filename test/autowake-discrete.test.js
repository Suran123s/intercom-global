const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { wakeCliAgent } = require('../src/controllers/autowake');
const { readInbox, clearInbox } = require('../src/core/mesh');

test('Improvement #23: wakeCliAgent writes atomic discrete envelope', async () => {
  const target = 'autowake_disc_' + Date.now();
  const res = wakeCliAgent(target, 'Discrete wake instruction');

  assert.strictEqual(res.delivered, true);
  assert.ok(fs.existsSync(res.file), 'Discrete file must exist');

  const inbox = await readInbox(target);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].message, 'Discrete wake instruction');
  assert.strictEqual(inbox[0].read, false);

  await clearInbox(target);
});
