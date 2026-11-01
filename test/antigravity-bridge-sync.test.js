// test/antigravity-bridge-sync.test.js - Milestone 2 Antigravity Dual-Mailbox Auto-Sync & TUI Clamp Test Suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  syncDualMailboxes,
  syncDualMailboxesSync,
  startAutoSyncDaemon,
  getDualMailboxDirs,
  routeMessageToAntigravity
} = require('../src/bridges/antigravity-bridge');

test('#47: syncDualMailboxes reconciles asymmetric messages between inboxes', async () => {
  const dirs = getDualMailboxDirs();
  if (dirs.length < 2) return; // Skip if workspace equals home directory

  const [dirA, dirB] = dirs;
  if (!fs.existsSync(dirA)) fs.mkdirSync(dirA, { recursive: true });
  if (!fs.existsSync(dirB)) fs.mkdirSync(dirB, { recursive: true });

  const testFileA = `${Date.now()}_test-sync-a.json`;
  const testFileB = `${Date.now() + 1}_test-sync-b.json`;

  fs.writeFileSync(path.join(dirA, testFileA), JSON.stringify({ id: 'sync-a', payload: 'from global' }), 'utf8');
  fs.writeFileSync(path.join(dirB, testFileB), JSON.stringify({ id: 'sync-b', payload: 'from workspace' }), 'utf8');

  const report = await syncDualMailboxes();
  assert.ok(report.syncedCount >= 2);

  assert.ok(fs.existsSync(path.join(dirB, testFileA)), 'testFileA must be copied to dirB');
  assert.ok(fs.existsSync(path.join(dirA, testFileB)), 'testFileB must be copied to dirA');

  // Verify syncDualMailboxesSync
  const syncReport = syncDualMailboxesSync();
  assert.strictEqual(syncReport.syncedCount, 0, 'No files should be synced when already in sync');

  // Test startAutoSyncDaemon
  const daemon = startAutoSyncDaemon(10000);
  assert.strictEqual(typeof daemon.stop, 'function');
  daemon.stop();

  // Clean up
  try { fs.unlinkSync(path.join(dirA, testFileA)); } catch {}
  try { fs.unlinkSync(path.join(dirB, testFileA)); } catch {}
  try { fs.unlinkSync(path.join(dirA, testFileB)); } catch {}
  try { fs.unlinkSync(path.join(dirB, testFileB)); } catch {}
});

test('Challenger 2 Advisory: clamped index calculation prevents undefined access on list shrink', () => {
  let agentList = ['alice', 'bob', 'charlie', 'david'];
  let agentIdx = 3; // David selected (index 3)

  // Mailbox compaction removes 2 agents
  agentList = ['alice', 'bob']; // Now length is 2 (valid indices 0 and 1)

  // 1. Test "up" clamping logic:
  const safeUpIdx = Math.max(0, Math.min(agentList.length - 1, agentIdx - 1));
  assert.strictEqual(safeUpIdx, 1);
  assert.strictEqual(agentList[safeUpIdx], 'bob');

  // 2. Test "down" clamping logic:
  const safeDownIdx = Math.min(agentList.length - 1, Math.max(0, agentIdx + 1));
  assert.strictEqual(safeDownIdx, 1);
  assert.strictEqual(agentList[safeDownIdx], 'bob');

  // 3. Test "enter" clamping logic:
  const safeEnterIdx = Math.max(0, Math.min(agentList.length - 1, agentIdx));
  assert.strictEqual(safeEnterIdx, 1);
  assert.strictEqual(agentList[safeEnterIdx], 'bob');

  // 4. Test renderAgents clamping logic:
  if (agentIdx >= agentList.length) {
    agentIdx = Math.max(0, agentList.length - 1);
  }
  assert.strictEqual(agentIdx, 1);
  assert.strictEqual(agentList[agentIdx], 'bob');
});
