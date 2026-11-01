/**
 * test/tui-async.test.js
 *
 * Improvement #18: Blessed TUI async crash bugfix verification.
 */

const test = require('node:test');
const assert = require('node:assert');
const { listActiveMailboxes } = require('../src/core/mesh');

test('Improvement #18: listActiveMailboxes returns a valid awaitable promise of array', async () => {
  const result = listActiveMailboxes();
  assert.ok(result instanceof Promise || typeof result.then === 'function', 'Must return a Promise');
  
  const mailboxes = await result;
  assert.ok(Array.isArray(mailboxes), 'Resolved value must be an array');
  assert.doesNotThrow(() => {
    mailboxes.map(m => m.name);
  }, 'Must support .map without throwing');
});
