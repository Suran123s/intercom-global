/**
 * test/unit/cpu-spin-guards.test.js
 *
 * Regression guards ensuring no 100%-CPU spin loops or unthrottled file-watcher loops exist.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  sleepSyncSafe,
  listActiveMailboxes,
  isEphemeralMailboxName
} = require('../../src/core/mesh');

const ROOT = path.resolve(__dirname, '../..');

describe('CPU & Event-Loop Spin Guards', () => {
  test('sleepSyncSafe sleeps safely using non-busy wait and is exported', () => {
    assert.equal(typeof sleepSyncSafe, 'function');
    const t0 = performance.now();
    sleepSyncSafe(15);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 1000, `sleepSyncSafe(15) took too long: ${elapsed}ms`);
  });

  test('mesh.js and antigravity-bridge.js contain zero Date.now() busy-wait spin loops', () => {
    const meshSrc = fs.readFileSync(path.join(ROOT, 'src/core/mesh.js'), 'utf8');
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridges/antigravity-bridge.js'), 'utf8');
    const emptyBusySpinRe = /while\s*\([^)]*Date\.now\(\)[^)]*\)\s*\{\s*\}/;
    assert.equal(
      emptyBusySpinRe.test(meshSrc),
      false,
      'src/core/mesh.js must never contain empty Date.now() busy-wait spin loops'
    );
    assert.equal(
      emptyBusySpinRe.test(bridgeSrc),
      false,
      'src/bridges/antigravity-bridge.js must never contain empty Date.now() busy-wait spin loops'
    );
    assert.match(meshSrc, /function sleepSyncSafe\(/);
  });

  test('cli.js startFileMeshWatcher yields cleanly when no new unread messages were emitted', () => {
    const cliSrc = fs.readFileSync(path.join(ROOT, 'src/cli.js'), 'utf8');
    const fnMatch = cliSrc.match(/async function startFileMeshWatcher[\s\S]*?^}/m);
    assert.ok(fnMatch, 'startFileMeshWatcher function must exist in src/cli.js');
    const body = fnMatch[0];
    assert.match(body, /newCount/, 'startFileMeshWatcher must track newly emitted message count');
    assert.match(body, /setTimeout\s*\(/, 'startFileMeshWatcher must yield via setTimeout between loop iterations');
  });

  test('isEphemeralMailboxName & listActiveMailboxes({ excludeEphemeral: true }) filter test noise safely', async (t) => {
    const { withIsolatedMeshEnv } = require('../helpers/isolated-env');
    withIsolatedMeshEnv(t, 'intercom-spin-ephem-');
    assert.equal(isEphemeralMailboxName('test_1794400000000'), true);
    assert.equal(isEphemeralMailboxName('agent_sender_003f32'), true);
    assert.equal(isEphemeralMailboxName('cli-test-1794424378454'), true);
    assert.equal(isEphemeralMailboxName('antigravity'), false);
    assert.equal(isEphemeralMailboxName('opencode'), false);

    const cleanPeers = await listActiveMailboxes({ excludeEphemeral: true });
    assert.ok(Array.isArray(cleanPeers));
    assert.equal(
      cleanPeers.some((p) => isEphemeralMailboxName(p.name)),
      false,
      'excludeEphemeral: true must omit ephemeral test mailboxes'
    );
  });
});
