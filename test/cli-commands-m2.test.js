// test/cli-commands-m2.test.js - Milestone 2 CLI Commands Test Suite
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const { enqueueDlq, clearDlq, getDlq } = require('../src/core/dlq');
const { clearChannel, readChannel } = require('../src/core/mesh');

test('#45: CLI dlq list, show, and clear commands', () => {
  clearDlq();

  // Populate DLQ with test failures
  enqueueDlq({
    id: 'cli-dlq-test-1',
    to: 'target-agent-a',
    from: 'dispatcher-1',
    message: 'Payload delivery failed'
  }, 'Simulated gateway timeout');

  enqueueDlq({
    id: 'cli-dlq-test-2',
    to: 'target-agent-b',
    from: 'dispatcher-2',
    message: 'Process crashed'
  }, 'Out of memory');

  // 1. dlq list
  const listOut = execSync('node bin/intercom.js dlq list', { encoding: 'utf8' });
  assert.match(listOut, /DEAD LETTER QUEUE/i);
  assert.match(listOut, /cli-dlq-test-1/);
  assert.match(listOut, /cli-dlq-test-2/);

  // 2. dlq list --json
  const listJsonOut = execSync('node bin/intercom.js dlq list --json', { encoding: 'utf8' });
  const parsedList = JSON.parse(listJsonOut);
  assert.strictEqual(parsedList.length, 2);
  assert.strictEqual(parsedList[0].id, 'cli-dlq-test-1');

  // 3. dlq show <id>
  const showOut = execSync('node bin/intercom.js dlq show cli-dlq-test-1', { encoding: 'utf8' });
  assert.match(showOut, /cli-dlq-test-1/);
  assert.match(showOut, /Simulated gateway timeout/);

  // 4. dlq show <id> --json
  const showJsonOut = execSync('node bin/intercom.js dlq show cli-dlq-test-1 --json', { encoding: 'utf8' });
  const parsedItem = JSON.parse(showJsonOut);
  assert.strictEqual(parsedItem.id, 'cli-dlq-test-1');
  assert.strictEqual(parsedItem.to, 'target-agent-a');

  // 5. dlq clear
  const clearOut = execSync('node bin/intercom.js dlq clear', { encoding: 'utf8' });
  assert.match(clearOut, /Dead Letter Queue cleared/i);
  assert.strictEqual(getDlq().length, 0);

  // Verify dlq list shows clean
  const cleanListOut = execSync('node bin/intercom.js dlq list', { encoding: 'utf8' });
  assert.match(cleanListOut, /DLQ is clean/i);
});

test('#46: CLI channel send, list, and read commands', () => {
  const testChannel = `test-chan-${Date.now()}`;
  clearChannel(testChannel);

  // 1. channel send (formatted)
  const sendOut1 = execSync(`node bin/intercom.js channel send #${testChannel} "Broadcast message 1" --from agent-alpha`, { encoding: 'utf8' });
  assert.match(sendOut1, /CHANNEL PUBLISHED/i);
  assert.match(sendOut1, new RegExp(`#${testChannel}`));

  // 2. channel send (--json)
  const sendOut2 = execSync(`node bin/intercom.js channel send #${testChannel} "Broadcast message 2" --from agent-beta --json`, { encoding: 'utf8' });
  const parsedRes = JSON.parse(sendOut2);
  assert.strictEqual(parsedRes.channel, `#${testChannel}`);
  assert.strictEqual(parsedRes.message, 'Broadcast message 2');
  assert.strictEqual(parsedRes.from, 'agent-beta');

  // 3. channel list
  const listOut = execSync('node bin/intercom.js channel list', { encoding: 'utf8' });
  assert.match(listOut, new RegExp(`#${testChannel}`));

  // 4. channel list --json
  const listJsonOut = execSync('node bin/intercom.js channel list --json', { encoding: 'utf8' });
  const parsedChans = JSON.parse(listJsonOut);
  const foundChan = parsedChans.find(c => c.name === `#${testChannel}`);
  assert.ok(foundChan);
  assert.strictEqual(foundChan.total, 2);

  // 5. channel read
  const readOut = execSync(`node bin/intercom.js channel read #${testChannel}`, { encoding: 'utf8' });
  assert.match(readOut, /Broadcast message 1/);
  assert.match(readOut, /Broadcast message 2/);

  // 6. channel read --json
  const readJsonOut = execSync(`node bin/intercom.js channel read #${testChannel} --json`, { encoding: 'utf8' });
  const parsedMsgs = JSON.parse(readJsonOut);
  assert.strictEqual(parsedMsgs.length, 2);
  assert.strictEqual(parsedMsgs[0].message, 'Broadcast message 1');
  assert.strictEqual(parsedMsgs[1].message, 'Broadcast message 2');

  // Clean up
  clearChannel(testChannel);
  assert.strictEqual(readChannel(testChannel).length, 0);
});
