/**
 * test/tui-async.test.js
 *
 * Improvement #18: Blessed TUI async crash bugfix verification against real bin/intercom-tui.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const { listActiveMailboxes, writeMessage } = require('../src/core/mesh');
const tui = require('../bin/intercom-tui.js');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('Improvement #18: listActiveMailboxes returns a valid awaitable promise of array and TUI loadLists/refresh handles it cleanly', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-tui-async-');
  t.after(() => tui.destroyScreen());

  await writeMessage('async_peer_alpha', {
    sender: 'tester',
    recipient: 'async_peer_alpha',
    type: 'task_dispatch',
    payload: { message: 'hello async tui' }
  });

  const result = listActiveMailboxes();
  assert.ok(result instanceof Promise || typeof result.then === 'function', 'Must return a Promise');

  const mailboxes = await result;
  assert.ok(Array.isArray(mailboxes), 'Resolved value must be an array');
  assert.doesNotThrow(() => {
    mailboxes.map(m => m.name);
  }, 'Must support .map without throwing');

  await tui.loadLists();
  const state = tui.getState();
  assert.ok(Array.isArray(state.agentList));
  assert.ok(state.agentList.includes('async_peer_alpha'));

  tui.setState({ activeNav: 3 }); // Peers view
  await tui.refresh();
  const frame = tui.renderFrame(100, 30);
  assert.strictEqual(frame.length, 30);
});
