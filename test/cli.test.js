// test/cli.test.js
const test = require('node:test');
const assert = require('node:assert');
const { execSync, spawn } = require('child_process');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('CLI send, check, read, clear and peers commands', (t) => {
  const { env } = withIsolatedMeshEnv(t, 'intercom-cli-');
  const agent = 'cli-test-' + Date.now();

  // 1. send
  const sendOut = execSync(`node bin/intercom.js send --from tester --to ${agent} --msg "CLI test task"`, { encoding: 'utf8', env });
  assert.match(sendOut, /Message delivered/i);

  // 2. read
  const readOut = execSync(`node bin/intercom.js read --agent ${agent}`, { encoding: 'utf8', env });
  const parsed = JSON.parse(readOut);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].message, 'CLI test task');
  assert.strictEqual(parsed[0].read, false);

  // 3. check
  const checkOut = execSync(`node bin/intercom.js check --agent ${agent}`, { encoding: 'utf8', env });
  assert.match(checkOut, /CLI test task/);

  // 4. peers
  const peersOut = execSync(`node bin/intercom.js peers`, { encoding: 'utf8', env });
  assert.match(peersOut, new RegExp(agent, 'i'));

  // 5. clear
  const clearOut = execSync(`node bin/intercom.js clear --agent ${agent}`, { encoding: 'utf8', env });
  assert.match(clearOut, /Cleared inbox/i);

  const readAfterClear = execSync(`node bin/intercom.js read --agent ${agent}`, { encoding: 'utf8', env });
  assert.deepStrictEqual(JSON.parse(readAfterClear), []);
});

test('CLI watch command receives message reactively', async (t) => {
  const { env } = withIsolatedMeshEnv(t, 'intercom-cli-watch-');
  const agent = 'cli-watch-' + Date.now();

  const watcher = spawn('node', ['bin/intercom.js', 'watch', '--agent', agent, '--timeout', '5', '--json'], { env });
  let stdout = '';

  watcher.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  const sendTimer = setTimeout(() => {
    execSync(`node bin/intercom.js send --from sender --to ${agent} --msg "wake up"`, { env });
  }, 150);

  await new Promise((resolve, reject) => {
    watcher.on('error', (err) => {
      clearTimeout(sendTimer);
      reject(err);
    });
    watcher.on('close', (code) => {
      clearTimeout(sendTimer);
      try {
        assert.strictEqual(code, 0);
        const msgs = JSON.parse(stdout.trim());
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].message, 'wake up');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
});
