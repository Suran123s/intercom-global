const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startDaemon, stopDaemon, daemonStatus, readPid } = require('../src/core/daemon-manager');
const { withIsolatedMeshEnv, getFreePort } = require('./helpers/isolated-env');

test('readPid handles missing, corrupt, and valid PID files', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-daemon-pid-');
  const pidFile = path.join(meshDir, 'daemon.pid');

  // Non-existent PID file
  assert.strictEqual(readPid(), null);

  // Non-numeric / corrupt content
  fs.writeFileSync(pidFile, 'not-a-pid-string', 'utf8');
  assert.strictEqual(readPid(), null);

  // Unreadable content / invalid JSON or symbol
  fs.writeFileSync(pidFile, 'NaN', 'utf8');
  assert.strictEqual(readPid(), null);

  // Valid PID number with trailing spaces/newlines
  fs.writeFileSync(pidFile, '  88888 \n', 'utf8');
  assert.strictEqual(readPid(), 88888);
});

test('daemonStatus returns offline when PID file is missing or PID is not running', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-daemon-status-');
  const pidFile = path.join(meshDir, 'daemon.pid');

  // Missing PID file
  assert.deepStrictEqual(daemonStatus(), { status: 'offline', pid: null });

  // Stale PID file for process that does not exist
  fs.writeFileSync(pidFile, '9999999', 'utf8');
  assert.deepStrictEqual(daemonStatus(), { status: 'offline', pid: null });
});

test('stopDaemon handles non-running and stale PID files', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-daemon-stop-');
  const pidFile = path.join(meshDir, 'daemon.pid');

  // No PID file
  const resNoFile = stopDaemon();
  assert.strictEqual(resNoFile.status, 'not_running');

  // Stale PID file -> removes file and returns not_running
  fs.writeFileSync(pidFile, '9999999', 'utf8');
  const resStale = stopDaemon();
  assert.strictEqual(resStale.status, 'not_running');
  assert.strictEqual(fs.existsSync(pidFile), false);
});

test('startDaemon, daemonStatus, duplicate start, and stopDaemon lifecycle', async (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-daemon-life-');
  const pidFile = path.join(meshDir, 'daemon.pid');
  t.after(() => {
    try { stopDaemon(); } catch {}
  });

  // 1. Start daemon process on ephemeral free port
  const port = await getFreePort();
  const startRes = startDaemon(port);
  assert.strictEqual(startRes.status, 'started');
  assert.strictEqual(typeof startRes.pid, 'number');
  assert.ok(startRes.pid > 0);
  assert.strictEqual(startRes.port, port);
  assert.strictEqual(readPid(), startRes.pid);

  // 2. Query status -> online
  const statusRes = daemonStatus();
  assert.strictEqual(statusRes.status, 'online');
  assert.strictEqual(statusRes.pid, startRes.pid);

  // 3. Attempt duplicate start -> already_running
  const dupRes = startDaemon(port);
  assert.strictEqual(dupRes.status, 'already_running');
  assert.strictEqual(dupRes.pid, startRes.pid);
  assert.strictEqual(dupRes.port, port);

  // 4. Stop daemon -> stopped and PID file removed
  const stopRes = stopDaemon();
  assert.strictEqual(stopRes.status, 'stopped');
  assert.strictEqual(stopRes.pid, startRes.pid);
  assert.strictEqual(fs.existsSync(pidFile), false);

  // 5. Query status after stop -> offline
  const finalStatus = daemonStatus();
  assert.strictEqual(finalStatus.status, 'offline');
  assert.strictEqual(finalStatus.pid, null);
});
