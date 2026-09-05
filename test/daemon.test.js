const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../src/config');
const { startDaemon, stopDaemon, daemonStatus, readPid } = require('../src/core/daemon-manager');

const PID_FILE = path.join(MESH_DIR, 'daemon.pid');

function cleanPidFile() {
  if (fs.existsSync(PID_FILE)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
  }
}

test('readPid handles missing, corrupt, and valid PID files', () => {
  cleanPidFile();

  // Non-existent PID file
  assert.strictEqual(readPid(), null);

  // Non-numeric / corrupt content
  fs.writeFileSync(PID_FILE, 'not-a-pid-string', 'utf8');
  assert.strictEqual(readPid(), null);

  // Unreadable content / invalid JSON or symbol
  fs.writeFileSync(PID_FILE, 'NaN', 'utf8');
  assert.strictEqual(readPid(), null);

  // Valid PID number with trailing spaces/newlines
  fs.writeFileSync(PID_FILE, '  88888 \n', 'utf8');
  assert.strictEqual(readPid(), 88888);

  cleanPidFile();
});

test('daemonStatus returns offline when PID file is missing or PID is not running', () => {
  cleanPidFile();

  // Missing PID file
  assert.deepStrictEqual(daemonStatus(), { status: 'offline', pid: null });

  // Stale PID file for process that does not exist
  fs.writeFileSync(PID_FILE, '9999999', 'utf8');
  assert.deepStrictEqual(daemonStatus(), { status: 'offline', pid: null });

  cleanPidFile();
});

test('stopDaemon handles non-running and stale PID files', () => {
  cleanPidFile();

  // No PID file
  const resNoFile = stopDaemon();
  assert.strictEqual(resNoFile.status, 'not_running');

  // Stale PID file -> removes file and returns not_running
  fs.writeFileSync(PID_FILE, '9999999', 'utf8');
  const resStale = stopDaemon();
  assert.strictEqual(resStale.status, 'not_running');
  assert.strictEqual(fs.existsSync(PID_FILE), false);

  cleanPidFile();
});

test('startDaemon, daemonStatus, duplicate start, and stopDaemon lifecycle', () => {
  cleanPidFile();

  // 1. Start daemon process
  const port = 4199;
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
  assert.strictEqual(fs.existsSync(PID_FILE), false);

  // 5. Query status after stop -> offline
  const finalStatus = daemonStatus();
  assert.strictEqual(finalStatus.status, 'offline');
  assert.strictEqual(finalStatus.pid, null);

  cleanPidFile();
});
