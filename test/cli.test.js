// test/cli.test.js
const test = require('node:test');
const assert = require('node:assert');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getInboxFile } = require('../src/core/mesh');

test('CLI send, check, read, clear and peers commands', () => {
  const agent = 'cli-test-' + Date.now();
  const file = getInboxFile(agent);

  // 1. send
  const sendOut = execSync(`node bin/intercom.js send --from tester --to ${agent} --msg "CLI test task"`, { encoding: 'utf8' });
  assert.match(sendOut, /Message delivered/i);

  // 2. read
  const readOut = execSync(`node bin/intercom.js read --agent ${agent}`, { encoding: 'utf8' });
  const parsed = JSON.parse(readOut);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].message, 'CLI test task');
  assert.strictEqual(parsed[0].read, false);

  // 3. check
  const checkOut = execSync(`node bin/intercom.js check --agent ${agent}`, { encoding: 'utf8' });
  assert.match(checkOut, /CLI test task/);

  // 4. peers
  const peersOut = execSync(`node bin/intercom.js peers`, { encoding: 'utf8' });
  assert.match(peersOut, new RegExp(agent, 'i'));

  // 5. clear
  const clearOut = execSync(`node bin/intercom.js clear --agent ${agent}`, { encoding: 'utf8' });
  assert.match(clearOut, /Cleared inbox/i);

  const readAfterClear = execSync(`node bin/intercom.js read --agent ${agent}`, { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(readAfterClear), []);

  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
});

test('CLI watch command receives message reactively', (t, done) => {
  const agent = 'cli-watch-' + Date.now();
  const file = getInboxFile(agent);

  const watcher = spawn('node', ['bin/intercom.js', 'watch', '--agent', agent, '--timeout', '5', '--json']);
  let stdout = '';

  watcher.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  setTimeout(() => {
    execSync(`node bin/intercom.js send --from sender --to ${agent} --msg "wake up"`);
  }, 300);

  watcher.on('close', (code) => {
    assert.strictEqual(code, 0);
    const msgs = JSON.parse(stdout.trim());
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].message, 'wake up');

    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    done();
  });
});
