// test/channel-cas.test.js - Milestone 2 Channel CAS Locking & Stress Test Suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const {
  sendChannelMessage,
  readChannel,
  listChannels,
  clearChannel,
  getChannelFile
} = require('../src/core/mesh');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('#42: sendChannelMessage executes thread-safe writes with directory CAS locks', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-chan-cas-');
  const chanName = `stress-chan-${Date.now()}`;
  clearChannel(chanName);

  const concurrency = 15;
  const promises = [];
  for (let i = 0; i < concurrency; i++) {
    promises.push((async () => {
      return sendChannelMessage(chanName, `sender-${i}`, `Message from ${i}`);
    })());
  }

  const results = await Promise.all(promises);
  assert.strictEqual(results.length, concurrency);

  const history = readChannel(chanName);
  assert.strictEqual(history.length, concurrency, `Expected ${concurrency} messages, got ${history.length}`);

  const senders = new Set(history.map(m => m.from));
  assert.strictEqual(senders.size, concurrency);

  const allChans = listChannels();
  const chanObj = allChans.find(c => c.name === `#${chanName}`);
  assert.ok(chanObj, `Channel #${chanName} must be listed`);
  assert.strictEqual(chanObj.total, concurrency);

  clearChannel(chanName);
  assert.strictEqual(readChannel(chanName).length, 0);
});

test('#42: Channel name normalization (#prefix vs plain) and JSON integrity', (t) => {
  withIsolatedMeshEnv(t, 'intercom-chan-norm-');
  const baseName = `norm-chan-${Date.now()}`;
  clearChannel(baseName);

  const res1 = sendChannelMessage(baseName, 'agent-1', 'Message 1');
  assert.strictEqual(res1.channel, `#${baseName}`);

  const res2 = sendChannelMessage(`#${baseName}`, 'agent-2', 'Message 2');
  assert.strictEqual(res2.channel, `#${baseName}`);

  const msgs = readChannel(baseName);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].message, 'Message 1');
  assert.strictEqual(msgs[1].message, 'Message 2');

  const file = getChannelFile(baseName);
  assert.ok(fs.existsSync(file));
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));

  clearChannel(baseName);
  assert.strictEqual(fs.existsSync(file), false);
});
