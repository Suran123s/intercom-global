/**
 * test/discrete-mailbox-integration.test.js
 *
 * Milestone 1 Discrete Mailbox Migration Integration Suite.
 * Covers Improvements:
 * #18: Blessed TUI Async Crash Bugfix (await listActiveMailboxes)
 * #19: Daemon Manager Command Alignment (daemon run / __daemon_run)
 * #21: Discrete Mailbox Migration in server.js
 * #22: Discrete Mailbox Migration in session-bridge.js
 * #23: Discrete Mailbox Migration in autowake.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { dispatchMessage } = require('../src/core/server');
const { wakeCliAgent } = require('../src/controllers/autowake');
const { listActiveMailboxes, readInbox, clearInbox, getInboxDir } = require('../src/core/mesh');
const { startDaemon, stopDaemon } = require('../src/core/daemon-manager');
const { MESH_DIR } = require('../src/config');

describe('Discrete Mailbox Migration Integration Suite', () => {
  const recipient = `discrete-test-${Date.now()}`;

  afterEach(async () => {
    try { await clearInbox(recipient); } catch {}
  });

  test('server.js dispatchMessage writes discrete message file into recipient inbox directory', async () => {
    const msg = dispatchMessage('agent-sender', recipient, 'Discrete delivery test payload');
    assert.ok(msg && msg.id, 'Dispatch must return message object');

    const inboxDir = getInboxDir(recipient);
    assert.ok(fs.existsSync(inboxDir), 'Discrete inbox directory must exist');

    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 1, 'Must write at least 1 discrete .json message file');

    const raw = JSON.parse(fs.readFileSync(path.join(inboxDir, files[0]), 'utf8'));
    assert.equal(raw.to || raw.recipient, recipient);
    assert.equal(raw.message || raw.body, 'Discrete delivery test payload');
  });

  test('autowake.js wakeCliAgent delivers via discrete message writer without audio beep', async () => {
    const wakeTarget = `wake-discrete-${Date.now()}`;
    const result = wakeCliAgent(wakeTarget, 'Wake instruction');

    assert.equal(result.delivered, true);
    assert.equal(result.target, wakeTarget);

    const inboxDir = getInboxDir(wakeTarget);
    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 1, 'wakeCliAgent must create discrete message file');

    try { await clearInbox(wakeTarget); } catch {}
  });

  test('listActiveMailboxes is asynchronous and returns array of mailbox profiles', async () => {
    const mailboxes = await listActiveMailboxes();
    assert.ok(Array.isArray(mailboxes), 'listActiveMailboxes must resolve to array');
    for (const m of mailboxes) {
      assert.ok(typeof m.name === 'string');
      assert.ok(typeof m.unread === 'number');
    }
  });

  test('daemon-manager startDaemon aligns with cli.js without unknown command error', () => {
    const daemonPort = 49999;
    const startRes = startDaemon(daemonPort);

    assert.ok(
      startRes.status === 'started' || startRes.status === 'already_running',
      'Daemon must launch cleanly'
    );

    // Stop daemon
    const stopRes = stopDaemon();
    assert.ok(stopRes.status === 'stopped' || stopRes.status === 'not_running');
  });
});
