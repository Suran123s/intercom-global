const test = require('node:test');
const assert = require('node:assert');
const { startDaemon, stopDaemon, daemonStatus } = require('../src/core/daemon-manager');

test('Improvement #19: startDaemon successfully keeps HTTP server alive and healthy', async () => {
  stopDaemon();
  const testPort = 4198;
  const start = startDaemon(testPort);
  assert.ok(start.status === 'started' || start.status === 'already_running');
  assert.ok(start.pid > 0);

  // Poll for up to 3 seconds for server to be responsive on HTTP
  let healthy = false;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {}
  }

  assert.strictEqual(healthy, true, 'Spawned daemon must be responding on /health');

  const status = daemonStatus();
  assert.strictEqual(status.status, 'online');
  assert.strictEqual(status.pid, start.pid);

  const stop = stopDaemon();
  assert.strictEqual(stop.status, 'stopped');
});
