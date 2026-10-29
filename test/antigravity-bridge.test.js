// test/antigravity-bridge.test.js - Unit and Integration Tests for Antigravity Bridge
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  getAntigravityConfig,
  getDualMailboxDirs,
  routeMessageToAntigravity,
  readAntigravityInboxSync
} = require('../src/bridges/antigravity-bridge');

test('antigravity-bridge: getDualMailboxDirs returns user and workspace inboxes', () => {
  const dirs = getDualMailboxDirs();
  assert(Array.isArray(dirs), 'getDualMailboxDirs should return an array');
  assert(dirs.length >= 2, 'Should contain at least user and workspace inboxes');
  assert(dirs.some(d => d.includes('antigravity')), 'Should point to antigravity inbox');
});

test('antigravity-bridge: getAntigravityConfig probes 58055 and extracts csrfToken if live', async () => {
  const result = await getAntigravityConfig({ timeoutMs: 2000 });
  assert(typeof result === 'object', 'Result should be an object');
  assert('online' in result, 'Result should have online flag');
  if (result.online) {
    assert(result.csrfToken, 'If online, csrfToken should be extracted from window.__APP_CONFIG__');
    assert.strictEqual(typeof result.csrfToken, 'string');
    assert(result.config, 'Config object should be populated');
  }
});

test('antigravity-bridge: routeMessageToAntigravity delivers to dual mailboxes', async () => {
  const testMsg = {
    id: `test_ag_${Date.now()}`,
    sender: 'test_parent',
    message: 'Hello Antigravity supervisor',
    type: 'task_dispatch',
    priority: 'HIGH'
  };

  const receipt = await routeMessageToAntigravity(testMsg);
  assert.strictEqual(receipt.success, true, 'Delivery should report success');
  assert(receipt.dualMailboxes.length >= 1, 'At least one mailbox path should be written');

  for (const mPath of receipt.dualMailboxes) {
    assert(fs.existsSync(mPath), `File should exist on disk: ${mPath}`);
    const raw = fs.readFileSync(mPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.id, testMsg.id);
    assert.strictEqual(parsed.recipient, 'antigravity');
    assert.strictEqual(parsed.payload.message, testMsg.message);
    // Cleanup
    try { fs.unlinkSync(mPath); } catch {}
  }
});

test('antigravity-bridge: readAntigravityInboxSync reads and sorts messages', async () => {
  const testMsg = {
    id: `test_read_${Date.now()}`,
    sender: 'test_harness',
    message: 'Synchronous read test',
    type: 'status_update'
  };

  const receipt = await routeMessageToAntigravity(testMsg);
  assert.strictEqual(receipt.success, true);

  const messages = readAntigravityInboxSync();
  assert(Array.isArray(messages), 'readAntigravityInboxSync should return an array');
  const found = messages.find(m => m.id === testMsg.id);
  assert(found, 'Should find the routed message in inbox');

  // Cleanup
  for (const mPath of receipt.dualMailboxes) {
    try { fs.unlinkSync(mPath); } catch {}
  }
});
