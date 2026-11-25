// test/adversarial-challenger-m1.test.js
// EMPIRICAL CHALLENGER 2: Adversarial Stress & Verification Harness for Milestone 1

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const {
  writeMessage,
  writeMessageSync,
  readInbox,
  readInboxSync,
  clearInbox,
  ackMessage,
  compactMailboxes,
  listActiveMailboxes,
  getInboxDir,
  getInboxFile,
  safeWriteJson,
  acquireLock,
  releaseLock
} = require('../src/core/mesh');
const { dispatchMessage } = require('../src/core/server');
const { startDaemon, stopDaemon, daemonStatus, readPid } = require('../src/core/daemon-manager');
const { getMeshDir } = require('../src/config');
const { withIsolatedMeshEnv, getFreePort, waitForCondition } = require('./helpers/isolated-env');

// Helper to clean up test agent mailboxes
function cleanupAgent(agentName) {
  try {
    const meshDir = getMeshDir();
    const inboxDir = path.join(meshDir, 'inbox', agentName);
    if (fs.existsSync(inboxDir)) {
      fs.rmSync(inboxDir, { recursive: true, force: true });
    }
    const legacyFile = getInboxFile(agentName);
    if (fs.existsSync(legacyFile)) {
      fs.unlinkSync(legacyFile);
    }
    const lockDir = path.join(meshDir, 'locks', `${agentName}.lock`);
    if (fs.existsSync(lockDir)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {}
}

// ============================================================================
// 1. CONCURRENT COMPACTION STRESS SUITE
// ============================================================================

test('1.1 Concurrent Compaction Stress: Zero data loss & active unread messages never deleted', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-11-');
  const agent = 'compaction-stress-' + Date.now();
  cleanupAgent(agent);

  const inboxDir = getInboxDir(agent);
  let stopCompaction = false;
  let compactionLoops = 0;
  let compactionErrors = [];

  // Start tight compaction loop in background
  const compactionPromise = (async () => {
    while (!stopCompaction) {
      try {
        await compactMailboxes({
          dryRun: false,
          pruneEmpty: true,
          pruneTemp: true,
          tempTtlMs: 20 // aggressive TTL to challenge race conditions
        });
        compactionLoops++;
      } catch (err) {
        compactionErrors.push(err);
      }
      await new Promise(r => setTimeout(r, 10));
    }
  })();

  // Concurrently dispatch messages across 10 parallel workers (80 messages)
  const totalMessages = 80;
  const writeErrors = [];
  const writtenIds = new Set();

  const writePromises = Array.from({ length: 10 }).map(async (_, workerIdx) => {
    for (let i = 0; i < 8; i++) {
      const msgIndex = workerIdx * 8 + i;
      try {
        if (msgIndex % 2 === 0) {
          const res = await writeMessage(agent, {
            sender: `worker-${workerIdx}`,
            recipient: agent,
            type: 'task_dispatch',
            payload: { index: msgIndex, text: `Hello from worker ${workerIdx} item ${i}` }
          });
          writtenIds.add(res.messageId);
        } else {
          const res = writeMessageSync(agent, {
            sender: `worker-sync-${workerIdx}`,
            recipient: agent,
            type: 'task_dispatch',
            payload: { index: msgIndex, text: `Sync hello ${msgIndex}` }
          });
          writtenIds.add(res.messageId);
        }
      } catch (err) {
        writeErrors.push(err);
      }
      await new Promise(r => setTimeout(r, 5));
    }
  });

  await Promise.all(writePromises);
  stopCompaction = true;
  await compactionPromise;

  assert.strictEqual(compactionErrors.length, 0, `Compaction errors: ${compactionErrors.map(e => e.message).join(', ')}`);
  assert.strictEqual(writeErrors.length, 0, `Write errors: ${writeErrors.map(e => e.message).join(', ')}`);
  assert.ok(compactionLoops > 0, 'Compaction must have executed at least once during write window');

  const remainingEnvelopes = readInboxSync(agent);
  assert.strictEqual(remainingEnvelopes.length, totalMessages, `Data loss! Expected ${totalMessages}, got ${remainingEnvelopes.length}`);

  for (const env of remainingEnvelopes) {
    assert.ok(writtenIds.has(env.id), `Unrecognized envelope: ${env.id}`);
    assert.strictEqual(env.read, false, 'Active messages must remain unread');
  }

  cleanupAgent(agent);
});

test('1.2 Compaction & CAS Lock Contention: Locked mailboxes are skipped and untouched', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-12-');
  const agent = 'locked-agent-' + Date.now();
  cleanupAgent(agent);

  // Write a message
  writeMessageSync(agent, {
    sender: 'operator',
    recipient: agent,
    type: 'task_dispatch',
    payload: { status: 'in-flight' }
  });

  // Acquire CAS lock on mailbox
  const lockHandle = await acquireLock(agent, { ttlMs: 5000 });
  assert.ok(lockHandle && lockHandle.token, 'Must acquire lock handle');

  // Run compaction
  const report = await compactMailboxes({
    pruneEmpty: true,
    pruneTemp: true,
    targetMailbox: agent
  });

  // Must report mailbox as skipped
  assert.ok(report.skippedLocked.includes(agent), `Expected ${agent} to be skipped due to lock, got: ${report.skippedLocked}`);

  // Release lock
  await releaseLock(lockHandle);

  // Verify message still intact
  const inbox = readInboxSync(agent);
  assert.strictEqual(inbox.length, 1);

  cleanupAgent(agent);
});

test('1.3 Compaction Orphaned Temp File Pruning: Prunes expired .tmp files and preserves .json messages', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-13-');
  const agent = 'temp-prune-' + Date.now();
  cleanupAgent(agent);

  const inboxDir = getInboxDir(agent);

  // Write 2 valid discrete messages
  writeMessageSync(agent, { sender: 'sender-1', recipient: agent, type: 'task_dispatch', payload: { id: 1 } });
  writeMessageSync(agent, { sender: 'sender-2', recipient: agent, type: 'task_dispatch', payload: { id: 2 } });

  // Create an expired .tmp file (simulate crashed writer from 2 minutes ago)
  const expiredTmpFile = path.join(inboxDir, `.tmp_crashed_${Date.now() - 120000}.tmp`);
  fs.writeFileSync(expiredTmpFile, 'partial write garbage', 'utf8');
  // Backdate mtime
  const pastTime = new Date(Date.now() - 120000);
  fs.utimesSync(expiredTmpFile, pastTime, pastTime);

  // Create a freshly created .tmp file (simulate active writer from 1 second ago)
  const freshTmpFile = path.join(inboxDir, `.tmp_active_${Date.now()}.tmp`);
  fs.writeFileSync(freshTmpFile, 'active write in progress', 'utf8');

  // Run compaction with tempTtlMs = 60000 (1 minute)
  const report = await compactMailboxes({
    pruneTemp: true,
    tempTtlMs: 60000,
    targetMailbox: agent
  });

  assert.strictEqual(report.prunedTempFiles, 1, `Expected 1 expired temp file pruned, got: ${report.prunedTempFiles}`);
  assert.strictEqual(fs.existsSync(expiredTmpFile), false, 'Expired temp file must be deleted');
  assert.strictEqual(fs.existsSync(freshTmpFile), true, 'Fresh temp file must NOT be deleted');

  // Valid messages must be intact
  const inbox = readInboxSync(agent);
  assert.strictEqual(inbox.length, 2, 'Both valid discrete messages must be intact');

  cleanupAgent(agent);
});

test('1.4 Compaction with Concurrent Message Acknowledgement & Archival', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-14-');
  const agent = 'ack-compact-' + Date.now();
  cleanupAgent(agent);

  // Write 10 messages
  const messageIds = [];
  for (let i = 0; i < 10; i++) {
    const res = writeMessageSync(agent, {
      sender: 'ack-sender',
      recipient: agent,
      type: 'task_dispatch',
      payload: { seq: i }
    });
    messageIds.push(res.messageId);
  }

  let stop = false;
  // Concurrently ack 5 messages with unlink
  const ackPromise = (async () => {
    for (let i = 0; i < 5; i++) {
      await ackMessage(agent, messageIds[i], { unlink: true });
      await new Promise(r => setTimeout(r, 10));
    }
  })();

  // Concurrently run compaction
  const compPromise = (async () => {
    while (!stop) {
      await compactMailboxes({ pruneEmpty: false, pruneTemp: true });
      await new Promise(r => setTimeout(r, 15));
    }
  })();

  await ackPromise;
  stop = true;
  await compPromise;

  const remaining = readInboxSync(agent);
  assert.strictEqual(remaining.length, 5, `Expected 5 unacknowledged messages remaining, got ${remaining.length}`);

  cleanupAgent(agent);
});

// ============================================================================
// 2. DISCRETE MAILBOX CONCURRENCY & NTFS CONTENTION SUITE
// ============================================================================

test('2.1 High Concurrency Discrete Writes: Zero corrupted JSON or zero-byte files', async (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-adv-m1-21-');
  const agent = 'high-concurrency-' + Date.now();
  cleanupAgent(agent);

  const concurrency = 20;
  const messagesPerWorker = 10;
  const totalExpected = concurrency * messagesPerWorker;

  const errors = [];
  const promises = [];

  for (let c = 0; c < concurrency; c++) {
    const workerId = c;
    promises.push((async () => {
      for (let m = 0; m < messagesPerWorker; m++) {
        try {
          if (m % 2 === 0) {
            dispatchMessage(`sender-${workerId}`, agent, `Dispatch payload ${workerId}-${m}`);
          } else {
            writeMessageSync(agent, {
              sender: `sender-sync-${workerId}`,
              recipient: agent,
              type: 'task_dispatch',
              payload: { message: `WriteMessageSync payload ${workerId}-${m}` }
            });
          }
        } catch (err) {
          errors.push(err);
        }
      }
    })());
  }

  await Promise.all(promises);

  assert.strictEqual(errors.length, 0, `Write errors: ${errors.map(e => e.message).join(', ')}`);

  const inboxDir = path.join(meshDir, 'inbox', agent);
  assert.ok(fs.existsSync(inboxDir));

  const files = fs.readdirSync(inboxDir);
  const msgFiles = files.filter(f => /^\d+_[a-zA-Z0-9\-]+\.json$/.test(f));
  assert.strictEqual(msgFiles.length, totalExpected, `Expected ${totalExpected} files, found ${msgFiles.length}`);

  let corrupted = 0;
  for (const f of msgFiles) {
    const full = path.join(inboxDir, f);
    const stat = fs.statSync(full);
    assert.ok(stat.size > 0, `Zero-byte file: ${f}`);
    try {
      const content = fs.readFileSync(full, 'utf8');
      const parsed = JSON.parse(content);
      assert.ok(parsed.id);
      assert.strictEqual(parsed.recipient, agent);
    } catch {
      corrupted++;
    }
  }

  assert.strictEqual(corrupted, 0, `Corrupted JSON count: ${corrupted}`);

  const loaded = readInboxSync(agent);
  assert.strictEqual(loaded.length, totalExpected);

  cleanupAgent(agent);
});

test('2.2 High Contention Read-Write Interleaving: Readers never see partial writes or JSON parse errors', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-22-');
  const agent = 'rw-interleave-' + Date.now();
  cleanupAgent(agent);

  let stop = false;
  let readerErrors = [];
  let totalReads = 0;

  // 5 parallel readers polling readInboxSync and readInbox
  const readerPromises = Array.from({ length: 5 }).map(async (_, rIdx) => {
    while (!stop) {
      try {
        const msgs = rIdx % 2 === 0 ? readInboxSync(agent) : await readInbox(agent);
        assert.ok(Array.isArray(msgs));
        totalReads++;
      } catch (err) {
        readerErrors.push(err);
      }
      await new Promise(r => setTimeout(r, 5));
    }
  });

  // 5 parallel writers continuously writing
  const writerPromises = Array.from({ length: 5 }).map(async (_, wIdx) => {
    for (let i = 0; i < 15; i++) {
      writeMessageSync(agent, {
        sender: `interleave-writer-${wIdx}`,
        recipient: agent,
        type: 'task_dispatch',
        payload: { item: i, timestamp: Date.now() }
      });
      await new Promise(r => setTimeout(r, 5));
    }
  });

  await Promise.all(writerPromises);
  stop = true;
  await Promise.all(readerPromises);

  assert.strictEqual(readerErrors.length, 0, `Reader errors: ${readerErrors.map(e => e.message).join(', ')}`);
  assert.ok(totalReads > 20, `Total reads should be significant, got: ${totalReads}`);

  const finalEnvelopes = readInboxSync(agent);
  assert.strictEqual(finalEnvelopes.length, 75, `Expected 75 total messages, got ${finalEnvelopes.length}`);

  cleanupAgent(agent);
});

test('2.3 Payload Stress: Multi-KB payloads, Unicode, emojis, and special characters preserved without corruption', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-23-');
  const agent = 'payload-stress-' + Date.now();
  cleanupAgent(agent);

  const largeText = 'A'.repeat(50000); // 50KB string
  const unicodeText = '🚀🔥🌐 こんにちは 世界 🌟 [CONIN$] [NUL] {test: true} "escaped" \\\\ path/to/something';

  const res1 = await writeMessage(agent, {
    sender: 'payload-sender',
    recipient: agent,
    type: 'task_dispatch',
    payload: { largeText, unicodeText }
  });

  const res2 = writeMessageSync(agent, {
    sender: 'payload-sender-sync',
    recipient: agent,
    type: 'task_dispatch',
    payload: { largeText, unicodeText }
  });

  const inbox = readInboxSync(agent);
  assert.strictEqual(inbox.length, 2);

  for (const env of inbox) {
    assert.strictEqual(env.payload.largeText.length, 50000);
    assert.strictEqual(env.payload.unicodeText, unicodeText);
  }

  cleanupAgent(agent);
});

// ============================================================================
// 3. BLESSED TUI STABILITY SUITE
// ============================================================================

test('3.1 listActiveMailboxes stability under concurrent mailbox creation and deletion', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-31-');
  const prefix = 'tui-churn-' + Date.now();
  const createdAgents = [];

  for (let i = 0; i < 20; i++) {
    const name = `${prefix}-${i}`;
    createdAgents.push(name);
    writeMessageSync(name, {
      sender: 'tui-tester',
      recipient: name,
      type: 'task_dispatch',
      payload: { index: i }
    });
  }

  const mailboxes1 = await listActiveMailboxes();
  assert.ok(Array.isArray(mailboxes1));
  const foundCreated = mailboxes1.filter(m => m.name.startsWith(prefix));
  assert.strictEqual(foundCreated.length, 20);

  let churnErrors = [];
  const churnReader = (async () => {
    for (let j = 0; j < 15; j++) {
      try {
        const list = await listActiveMailboxes();
        assert.ok(Array.isArray(list));
      } catch (err) {
        churnErrors.push(err);
      }
      await new Promise(r => setTimeout(r, 10));
    }
  })();

  const churnDeleter = (async () => {
    for (let k = 0; k < 10; k++) {
      cleanupAgent(createdAgents[k]);
      await new Promise(r => setTimeout(r, 15));
    }
  })();

  await Promise.all([churnReader, churnDeleter]);
  assert.strictEqual(churnErrors.length, 0, `listActiveMailboxes churn errors: ${churnErrors.map(e => e.message).join(', ')}`);

  for (const name of createdAgents) {
    cleanupAgent(name);
  }
});

test('3.2 Empirical Verification: Real TUI agentIdx Boundary Condition on Mailbox Shrink', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-32-');
  const tui = require('../bin/intercom-tui.js');
  t.after(() => tui.destroyScreen());

  // User had selected the 5th agent (index 4), then mailboxes shrank to 2
  tui.setState({
    activeNav: 3, // Peers view
    composerBuffer: '',
    agentList: ['agent1', 'agent2'],
    agentIdx: 4,
    selectedAgent: 'agent5'
  });

  // Pressing up in real TUI must clamp safely to valid index 1 ('agent2') instead of undefined
  await tui.handleKey('', { name: 'up' });
  const state = tui.getState();
  assert.strictEqual(state.agentIdx, 1, 'Safe clamping prevents out-of-bounds index');
  assert.strictEqual(state.selectedAgent, 'agent2', 'Safe clamping selects last valid agent');
  assert.doesNotThrow(() => tui.renderFrame(100, 30));
});

// ============================================================================
// 4. DAEMON ALIGNMENT & WINDOWS PROCESS ORPHAN VERIFICATION SUITE
// ============================================================================

test('4.1 Daemon Lifecycle: Start -> Health Probe -> Stop -> Clean Termination (No Orphans)', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-41-');
  t.after(() => { try { stopDaemon(); } catch {} });
  const testPort = await getFreePort();

  await stopDaemon(testPort);

  // Cycle 1: Start
  const start1 = startDaemon(testPort);
  assert.strictEqual(start1.status, 'started');
  const pid1 = start1.pid;
  assert.ok(pid1 && pid1 > 0);

  const online1 = await waitForCondition(async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/intercom/health`);
    return res.ok;
  }, { timeoutMs: 3000, intervalMs: 30, label: 'daemon cycle 1 health' });
  assert.ok(online1, 'Daemon health endpoint must be reachable');

  // Stop
  const stop1 = stopDaemon();
  assert.strictEqual(stop1.status, 'stopped');

  // Windows process death verification
  await waitForCondition(() => {
    try {
      process.kill(pid1, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 2000, intervalMs: 30, label: `PID ${pid1} termination` });

  // Cycle 2: Immediate re-start on same port
  const start2 = startDaemon(testPort);
  assert.strictEqual(start2.status, 'started');
  const pid2 = start2.pid;
  assert.notStrictEqual(pid1, pid2, 'New spawn must have different PID');

  const online2 = await waitForCondition(async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/intercom/health`);
    return res.ok;
  }, { timeoutMs: 3000, intervalMs: 30, label: 'daemon cycle 2 health' });
  assert.ok(online2, 'Daemon must be reachable after restart');

  // Stop 2
  const stop2 = stopDaemon();
  assert.strictEqual(stop2.status, 'stopped');

  await waitForCondition(() => {
    try {
      process.kill(pid2, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 2000, intervalMs: 30, label: `PID ${pid2} termination` });
});

test('4.2 Daemon Duplicate Start Prevention', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-m1-42-');
  t.after(() => { try { stopDaemon(); } catch {} });
  const testPort = await getFreePort();
  await stopDaemon(testPort);

  const start1 = startDaemon(testPort);
  assert.strictEqual(start1.status, 'started');

  // Attempt duplicate start
  const start2 = startDaemon(testPort);
  assert.strictEqual(start2.status, 'already_running', 'Duplicate start must return already_running');
  assert.strictEqual(start2.pid, start1.pid);

  stopDaemon();
  await waitForCondition(() => {
    try {
      process.kill(start1.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 2000, intervalMs: 30, label: `PID ${start1.pid} termination` });
});

test('4.3 Stale PID File Recovery: Gracefully recovers when PID file contains non-existent process', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-adv-m1-43-');
  const pidFile = path.join(meshDir, 'daemon.pid');

  // Write a fake, dead PID
  const fakeDeadPid = 999999;
  fs.writeFileSync(pidFile, String(fakeDeadPid), 'utf8');

  // daemonStatus should detect it is offline
  const status = daemonStatus();
  assert.strictEqual(status.status, 'offline');

  // stopDaemon should clean up the stale PID file without error
  const stopRes = stopDaemon();
  assert.strictEqual(stopRes.status, 'not_running');
  assert.strictEqual(fs.existsSync(pidFile), false, 'Stale PID file must be unlinked');
});

test('4.4 CLI Command Alignment: bin/intercom.js __daemon_run launches properly', async (t) => {
  const { env } = withIsolatedMeshEnv(t, 'intercom-adv-m1-44-');
  const testPort = await getFreePort();
  const binFile = path.resolve(__dirname, '../bin/intercom.js');

  const cliChild = spawn(process.execPath, [binFile, '__daemon_run', `--port=${testPort}`], {
    detached: true,
    stdio: 'ignore',
    env
  });
  cliChild.unref();
  t.after(() => {
    try { process.kill(cliChild.pid, 'SIGTERM'); } catch {}
  });

  const cliOnline = await waitForCondition(async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/intercom/health`);
    return res.ok;
  }, { timeoutMs: 3000, intervalMs: 30, label: 'CLI __daemon_run health' });
  assert.ok(cliOnline, 'CLI __daemon_run must start and respond to health check');

  // Terminate
  try {
    process.kill(cliChild.pid, 'SIGTERM');
  } catch {}
  await waitForCondition(() => {
    try {
      process.kill(cliChild.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 2000, intervalMs: 30, label: `CLI PID ${cliChild.pid} termination` });
});
