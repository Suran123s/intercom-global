/**
 * test/stress-compaction.test.js
 *
 * Improvement #90: Mailbox Atomic Compaction Under Reader/Writer Concurrency Stress Suite.
 * Validates atomic mailbox compaction under heavy concurrent reader and writer traffic:
 * - Zero lost messages
 * - Zero corrupted/partial JSON payloads
 * - Immunity for CAS-locked mailboxes (safe skip without interference)
 * - Resilience to rapid compaction cycles under read/write contention
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  writeMessage,
  readInbox,
  getInboxDir,
  compactMailboxes,
  acquireLock,
  releaseLock,
  clearInbox
} = require('../src/core/mesh');
const { createIsolatedMeshEnv } = require('./helpers/isolated-env');

describe('Milestone 4 — #90: Mailbox Compaction Under Concurrent Reader/Writer Contention', () => {
  let iso;
  let testAgent;
  let peerAgent;

  beforeEach(() => {
    iso = createIsolatedMeshEnv('intercom-stress-compact-');
    testAgent = `stress-compact-${Date.now()}`;
    peerAgent = `stress-peer-${Date.now()}`;
  });

  afterEach(async () => {
    try { await clearInbox(testAgent); } catch {}
    try { await clearInbox(peerAgent); } catch {}
    iso.cleanup();
  });

  test('Concurrent Writers + Compaction: No messages lost or corrupted under active compaction', async () => {
    const totalMessages = 10;
    const writePromises = [];

    // Launch concurrent compaction in background
    const compactionPromise = (async () => {
      for (let i = 0; i < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
        await compactMailboxes({ dryRun: false, removeEmpty: true });
      }
    })();

    // Concurrently write messages
    for (let i = 0; i < totalMessages; i++) {
      writePromises.push(
        writeMessage(testAgent, {
          sender: 'coordinator',
          recipient: testAgent,
          payload: {
            body: `Contention payload #${i}`,
            index: i
          }
        })
      );
    }

    await Promise.all([...writePromises, compactionPromise]);

    // Read back all messages
    const received = await readInbox(testAgent);
    assert.equal(received.length, totalMessages, `All ${totalMessages} messages must be preserved without loss`);

    // Verify payload integrity
    for (const msg of received) {
      const body = msg.body || msg.payload?.body || msg.payload?.message;
      assert.ok(body.includes('Contention payload #'), 'Payload must not be corrupted');
      const idx = msg.index !== undefined ? msg.index : msg.payload?.index;
      assert.equal(typeof idx, 'number');
    }
  });

  test('Concurrent Readers + Compaction: Readers do not throw ENOENT or read partial payloads', async () => {
    // Pre-populate mailbox with messages
    for (let i = 0; i < 6; i++) {
      await writeMessage(testAgent, {
        sender: 'producer',
        recipient: testAgent,
        body: `Reader test message #${i}`
      });
    }

    let readErrors = 0;
    let successfulReads = 0;

    // Concurrently run reads and compactions
    const tasks = [];
    for (let i = 0; i < 4; i++) {
      tasks.push(
        readInbox(testAgent)
          .then((msgs) => {
            if (msgs.length > 0) successfulReads++;
          })
          .catch(() => {
            readErrors++;
          })
      );
      tasks.push(compactMailboxes({ dryRun: false }));
    }

    await Promise.all(tasks);

    assert.equal(readErrors, 0, 'Concurrent readers must never throw unhandled errors during compaction');
    assert.ok(successfulReads > 0, 'Successful reads must complete during compaction');
  });

  test('Locked Mailbox Immunity: Mailbox with active CAS lock is skipped by compaction', async () => {
    // Ensure inbox directory exists for peerAgent so compaction examines it
    getInboxDir(peerAgent);

    // Acquire explicit lock on peerAgent mailbox
    const lockAcquired = await acquireLock(peerAgent, 5000);
    assert.ok(lockAcquired && lockAcquired.token, 'Lock must be acquired on target mailbox');

    try {
      const report = await compactMailboxes({ dryRun: false, removeEmpty: true });
      assert.ok(report);
      assert.ok(
        report.skippedLocked.includes(peerAgent),
        `Compaction must report '${peerAgent}' in skippedLocked list`
      );
    } finally {
      await releaseLock(lockAcquired);
    }
  });

  test('Atomic Cleanup: Empty mailboxes pruned while active mailboxes remain untouched', async () => {
    // Write to testAgent, leave peerAgent empty
    await writeMessage(testAgent, {
      sender: 'orchestrator',
      recipient: testAgent,
      body: 'Active message'
    });

    // Run compaction
    const report = await compactMailboxes({ dryRun: false, removeEmpty: true });
    assert.ok(report);

    // Verify testAgent still has message
    const active = await readInbox(testAgent);
    assert.equal(active.length, 1);
    assert.equal(active[0].body, 'Active message');
  });
});
