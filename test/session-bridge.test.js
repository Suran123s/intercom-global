const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../src/config');
const { writeInbox } = require('../src/core/mesh');
const { startSessionBridge, sanitizeName } = require('../src/bridges/session-bridge');

test('startSessionBridge function exists and exports correctly', () => {
  assert.strictEqual(typeof startSessionBridge, 'function');
  assert.strictEqual(typeof sanitizeName, 'function');
});

test('session-bridge sanitizeName cleans input and prevents path traversal', () => {
  assert.strictEqual(sanitizeName('cli-agent'), 'cli-agent');
  assert.strictEqual(sanitizeName('Agent_123'), 'agent_123');
  assert.strictEqual(sanitizeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeName('../foo/bar'), 'bar');
  assert.strictEqual(sanitizeName('..\\..\\windows\\system32'), 'system32');
  assert.strictEqual(sanitizeName('../../', 'fallback'), 'fallback');
  assert.strictEqual(sanitizeName('..', 'fallback'), 'fallback');
  assert.strictEqual(sanitizeName('/', 'fallback'), 'fallback');
  assert.strictEqual(sanitizeName('agent;rm -rf /'), 'agentrm-rf');
});

test('session bridge spawns process with shell set to false', (t) => {
  let capturedOptions = null;
  const originalSpawn = childProcess.spawn;
  const originalExit = process.exit;

  process.exit = () => {};

  let fakeChild = null;
  childProcess.spawn = (command, args, options) => {
    capturedOptions = options;
    fakeChild = new (require('events').EventEmitter)();
    fakeChild.stdin = { write: () => {} };
    fakeChild.unref = () => {};
    return fakeChild;
  };

  try {
    delete require.cache[require.resolve('../src/bridges/session-bridge')];
    const { startSessionBridge: freshStart } = require('../src/bridges/session-bridge');
    freshStart('test-agent', 's-test123', 'node', ['-v']);
    assert.ok(capturedOptions, 'spawn should have been called');
    assert.strictEqual(capturedOptions.shell, false, 'shell option should be false to prevent command injection');
  } finally {
    if (fakeChild) fakeChild.emit('close', 0);
    childProcess.spawn = originalSpawn;
    process.exit = originalExit;
    process.stdin.pause();
  }
});

test('session-bridge CLI spawns command and routes inbox messages to child stdin', async () => {
  const agent = 'test-sbridge-' + Date.now();
  const session = 'sess-' + Math.random().toString(36).substring(2, 8);
  const fullTag = `${agent}#${session}`;

  const helperScript = path.join(__dirname, `dummy_cli_${Date.now()}.js`);
  fs.writeFileSync(
    helperScript,
    'process.stdin.on("data", d => console.log("RECVD:" + d.toString().trim())); setTimeout(() => process.exit(0), 2800);'
  );

  const bridgeProcess = spawn('node', [
    path.join(__dirname, '../src/bridges/session-bridge.js'),
    '--agent', agent,
    '--session', session,
    '--',
    'node', helperScript
  ]);

  let stdout = '';
  bridgeProcess.stdout.on('data', (d) => {
    stdout += d.toString();
  });

  // Inject session-specific message
  setTimeout(() => {
    writeInbox(fullTag, [{ id: 'sb-1', from: 'master', to: fullTag, message: 'do session task', read: false }]);
  }, 1100);

  // Inject targeted general message
  setTimeout(() => {
    writeInbox(agent, [{ id: 'sb-2', from: 'master', to: agent, message: 'do general task', read: false }]);
  }, 1900);

  await new Promise((resolve, reject) => {
    bridgeProcess.on('close', (code) => {
      try {
        assert.strictEqual(code, 0);
        assert.match(stdout, /INJECTING TASK FROM MASTER/);
        assert.match(stdout, /RECVD:do session task/);
        assert.match(stdout, /RECVD:do general task/);

        // Verify that inbox messages were marked as read
        const sessionInbox = JSON.parse(fs.readFileSync(path.join(MESH_DIR, `${agent}-${session}.json`), 'utf8'));
        assert.strictEqual(sessionInbox[0].read, true);

        const generalInbox = JSON.parse(fs.readFileSync(path.join(MESH_DIR, `${agent}.json`), 'utf8'));
        assert.strictEqual(generalInbox[0].read, true);

        resolve();
      } catch (err) {
        reject(err);
      } finally {
        if (fs.existsSync(helperScript)) fs.unlinkSync(helperScript);
        const f1 = path.join(MESH_DIR, `${agent}.json`);
        const f2 = path.join(MESH_DIR, `${agent}-${session}.json`);
        if (fs.existsSync(f1)) fs.unlinkSync(f1);
        if (fs.existsSync(f2)) fs.unlinkSync(f2);
      }
    });
  });
});
