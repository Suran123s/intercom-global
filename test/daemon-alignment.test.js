const test = require('node:test');
const assert = require('node:assert');
const { startDaemon, stopDaemon, daemonStatus } = require('../src/core/daemon-manager');
const { withIsolatedMeshEnv, getFreePort, waitForCondition } = require('./helpers/isolated-env');

test('Improvement #19: startDaemon successfully keeps HTTP server alive and healthy', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-daemon-align-');
  t.after(() => {
    try { stopDaemon(); } catch {}
  });

  const testPort = await getFreePort();
  const start = startDaemon(testPort);
  assert.ok(start.status === 'started' || start.status === 'already_running');
  assert.ok(start.pid > 0);

  const healthy = await waitForCondition(async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    return res.ok;
  }, { timeoutMs: 3000, intervalMs: 30, label: 'daemon /health' });

  assert.strictEqual(healthy, true, 'Spawned daemon must be responding on /health');

  const status = daemonStatus();
  assert.strictEqual(status.status, 'online');
  assert.strictEqual(status.pid, start.pid);

  const stop = stopDaemon();
  assert.strictEqual(stop.status, 'stopped');
});
