/**
 * test/mailbox-compact.test.js
 *
 * Milestone 1 Mailbox Compaction Command & Pruner Test Suite.
 * Covers Improvement #20:
 * Implement `intercom compact` CLI command to clean up dead/ephemeral
 * mailboxes in `mesh/inbox/`, archiving read messages and preserving active queues.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  writeMessage,
  readInbox,
  getInboxDir,
  compactMailboxes,
  clearInbox
} = require('../src/core/mesh');
const { MESH_DIR } = require('../src/config');

describe('Mailbox Compaction & Ephemeral Pruning Suite', () => {
  const testAgent = `test-compact-${Date.now()}`;
  const ephemeralAgent = `ephemeral-subagent-${Date.now()}`;

  afterEach(async () => {
    try { await clearInbox(testAgent); } catch {}
    try { await clearInbox(ephemeralAgent); } catch {}
  });

  test('compactMailboxes prunes empty ephemeral inbox directories', async () => {
    const ephemDir = getInboxDir(ephemeralAgent);
    assert.ok(fs.existsSync(ephemDir), 'Ephemeral inbox dir must exist before compaction');

    const result = await compactMailboxes({ dryRun: false, removeEmpty: true });
    assert.ok(result.prunedDirs >= 1, 'Must report at least 1 pruned empty directory');
    assert.ok(!fs.existsSync(ephemDir), 'Empty ephemeral directory must be removed');
  });

  test('compactMailboxes preserves mailboxes containing unread messages', async () => {
    await writeMessage(testAgent, {
      sender: 'orchestrator',
      recipient: testAgent,
      body: 'Keep this message active'
    });

    const inboxBefore = await readInbox(testAgent);
    assert.equal(inboxBefore.length, 1);

    const result = await compactMailboxes({ dryRun: false });
    const inboxAfter = await readInbox(testAgent);

    assert.equal(inboxAfter.length, 1, 'Active unread messages must not be pruned');
  });

  test('compactMailboxes dry-run reports pruned candidates without disk deletions', async () => {
    const dryAgent = `dry-agent-${Date.now()}`;
    const dryDir = getInboxDir(dryAgent);

    const result = await compactMailboxes({ dryRun: true, removeEmpty: true });
    assert.equal(result.dryRun, true);
    assert.ok(fs.existsSync(dryDir), 'Dry-run must not delete directory from disk');

    // Clean up
    try { fs.rmdirSync(dryDir); } catch {}
  });

  test('CLI intercom compact runs cleanly and outputs structured summary', () => {
    const cliPath = path.join(__dirname, '../bin/intercom.js');
    const child = spawnSync(process.execPath, [cliPath, 'compact', '--dry-run'], {
      encoding: 'utf8',
      timeout: 15000
    });

    assert.equal(child.status, 0, `CLI compact must exit with 0 (stderr: ${child.stderr})`);
    assert.match(child.stdout, /compact|pruned|mailboxes/i);
  });
});
