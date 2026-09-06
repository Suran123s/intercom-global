const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('child_process');

test('session bridge spawns process with shell set to false', (t) => {
  let capturedOptions = null;
  const originalSpawn = childProcess.spawn;
  const originalExit = process.exit;

  process.exit = () => {};

  childProcess.spawn = (command, args, options) => {
    capturedOptions = options;
    const fakeChild = new (require('events').EventEmitter)();
    fakeChild.stdin = { write: () => {} };
    fakeChild.unref = () => {};
    // Emit close immediately to clear intervals and finish
    setImmediate(() => fakeChild.emit('close', 0));
    return fakeChild;
  };

  try {
    delete require.cache[require.resolve('../src/bridges/session-bridge')];
    const { startSessionBridge } = require('../src/bridges/session-bridge');
    startSessionBridge('test-agent', 's-test123', 'node', ['-v']);
    assert.ok(capturedOptions, 'spawn should have been called');
    assert.strictEqual(capturedOptions.shell, false, 'shell option should be false to prevent command injection');
  } finally {
    childProcess.spawn = originalSpawn;
    process.exit = originalExit;
    process.stdin.pause();
  }
});
