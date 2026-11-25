// test/adversarial-resilience.test.js - Tier 3 & 5 Adversarial Fallback, Security & Resilience Suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { MessageEnvelope } = require('../src/core/message');
const {
  writeMessage,
  readInbox,
  readInboxSync,
  ackMessage,
  clearInbox,
  clearInboxSync,
  validateAgentName,
  getInboxDir,
  SecurityError
} = require('../src/core/mesh');
const { IntercomDaemon } = require('../src/core/daemon');
const { registerAgent } = require('../src/core/registry');
const { interruptAgent } = require('../src/core/interrupter');
const {
  checkQuota,
  handleFallback,
  dispatchTask,
  getLedgerPath
} = require('../src/core/jules-delegator');
const {
  verifyZeroKill,
  validateAgentAction,
  resolveSafeAction,
  GovernanceViolationError
} = require('../src/core/governance');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

// -----------------------------------------------------------------------------
// TIER 3 & 5: DUAL-TRANSPORT FALLBACK
// -----------------------------------------------------------------------------

test('Tier 3 Fallback: Daemon HTTP offline / peer offline triggers safe-path file-mesh delivery without message loss', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-res-daemon-');
  const recipient = 'fallback_agent_' + Date.now();
  await clearInbox(recipient);

  // Sub-test 1: Daemon internal safe-path fallback when peer is not connected via SSE/WS
  const daemon = new IntercomDaemon({ port: 0 });
  await daemon.start();
  const testPort = daemon.port;

  try {
    const envelope1 = MessageEnvelope.create({
      sender: 'orchestrator_node',
      recipient,
      type: 'task_dispatch',
      priority: 'NORMAL',
      payload: { instruction: 'Execute task via daemon' }
    });

    // Peer is offline, so daemon falls back to safe-path discrete file-mesh
    const sendResult = await daemon.handleSend(envelope1.toJSON());
    assert.strictEqual(sendResult.status, 'DELIVERED_SAFE_PATH');
    assert.strictEqual(sendResult.messageId, envelope1.id);

    // Verify written to inbox on disk
    const inbox = await readInbox(recipient);
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].id, envelope1.id);
    assert.strictEqual(inbox[0].payload.instruction, 'Execute task via daemon');
  } finally {
    await daemon.stop();
  }

  // Sub-test 2: Daemon completely offline (server stopped) -> direct safe-path write
  const envelope2 = MessageEnvelope.create({
    sender: 'orchestrator_node',
    recipient,
    type: 'task_dispatch',
    priority: 'HIGH',
    payload: { instruction: 'Direct safe-path delivery when daemon offline' }
  });

  // Attempting HTTP send to closed port fails and falls back to writeMessage directly
  let httpFailed = false;
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/intercom/send',
        method: 'POST',
        timeout: 300
      }, resolve);
      req.on('error', reject);
      req.end();
    });
  } catch (err) {
    httpFailed = true;
  }
  assert.strictEqual(httpFailed, true, 'HTTP connection to stopped daemon must fail');

  // Fallback to safe-path discrete atomic file-mesh
  const fallbackResult = await writeMessage(recipient, envelope2);
  assert.strictEqual(fallbackResult.messageId, envelope2.id, 'Message ID must match');
  assert.ok(fs.existsSync(fallbackResult.path), 'File must exist on disk');

  // Verify recipient inbox now contains both messages in strict chronological order
  const finalInbox = await readInbox(recipient);
  assert.strictEqual(finalInbox.length, 2);
  assert.strictEqual(finalInbox[1].id, envelope2.id);

  // Clean up
  await clearInbox(recipient);
});

// -----------------------------------------------------------------------------
// TIER 3 & 5: JULES DELEGATION FALLBACK
// -----------------------------------------------------------------------------

test('Tier 3 Fallback: Jules quota full triggers automatic local worker fallback with disallowJulesReDelegation: true', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-res-jules-');
  const ledgerPath = getLedgerPath();
  let originalLedger = null;
  if (fs.existsSync(ledgerPath)) {
    try { originalLedger = fs.readFileSync(ledgerPath, 'utf8'); } catch {}
  }

  try {
    // 1. Simulate Concurrency Cap Full: 15 active sessions
    const fullActiveLedger = {
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 5,
      activeSessions: Array.from({ length: 15 }, (_, i) => ({
        id: `sess_active_${i}`,
        startedAt: new Date().toISOString()
      }))
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(fullActiveLedger, null, 2), 'utf8');

    const quotaActiveRes = await checkQuota({ dryRun: true });
    assert.strictEqual(quotaActiveRes.available, false);
    assert.strictEqual(quotaActiveRes.quotaExceeded, true);
    assert.ok(quotaActiveRes.reason.includes('concurrency cap reached'));

    // 2. Simulate Daily Cap Full: 100 sessions
    const fullDailyLedger = {
      dailyDate: new Date().toISOString().slice(0, 10),
      dailyCount: 100,
      activeSessions: []
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(fullDailyLedger, null, 2), 'utf8');

    const quotaDailyRes = await checkQuota({ dryRun: true });
    assert.strictEqual(quotaDailyRes.available, false);
    assert.strictEqual(quotaDailyRes.quotaExceeded, true);
    assert.ok(quotaDailyRes.reason.includes('daily session cap reached'));

    // 3. Fallback Plan Generation
    const sampleTask = {
      summary: 'Heavy refactor task',
      targetFiles: ['src/core/complex.js'],
      locModifications: 150,
      symptomContext: 'Memory leak in session table',
      acceptanceCriteria: ['Zero leak', 'Pass all tests'],
      testCommand: 'npm test',
      boundaries: ['No external network']
    };

    const fallbackPlan = handleFallback(sampleTask, 'Quota limit reached');
    assert.strictEqual(fallbackPlan.fallbackActivated, true);
    assert.strictEqual(fallbackPlan.disallowJulesReDelegation, true);
    assert.strictEqual(fallbackPlan.taskSpec.disallowJulesReDelegation, true);
    assert.strictEqual(fallbackPlan.type, 'TEAMWORK_WORKER');

    // Small task produces IN_SITU fallback
    const smallTask = {
      summary: 'Small fix',
      targetFiles: ['src/small.js'],
      locModifications: 20
    };
    const smallFallback = handleFallback(smallTask, 'Quota throttled');
    assert.strictEqual(smallFallback.type, 'IN_SITU');
    assert.strictEqual(smallFallback.disallowJulesReDelegation, true);

    // 4. dispatchTask auto-routes to fallback when quota is full
    const dispatchResult = await dispatchTask(sampleTask, { dryRun: true });
    assert.strictEqual(dispatchResult.fallbackActivated, true);
    assert.strictEqual(dispatchResult.disallowJulesReDelegation, true);
  } finally {
    // Restore or unlink ledger
    if (originalLedger !== null) {
      fs.writeFileSync(ledgerPath, originalLedger, 'utf8');
    } else if (fs.existsSync(ledgerPath)) {
      try { fs.unlinkSync(ledgerPath); } catch {}
    }
  }
});

// -----------------------------------------------------------------------------
// TIER 3 & 5: SECURITY FUZZING & WIN32 RESERVED NAMES
// -----------------------------------------------------------------------------

test('Tier 5 Security: Path traversal & Windows reserved DOS device names rejected across all core APIs', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-res-sec-');
  const traversalPayloads = [
    '../',
    '..\\',
    '../../etc/passwd',
    '..\\..\\windows\\system32',
    '%2e%2e%2f',
    '%2e%2e',
    '%2f',
    '%5c',
    'agent/../../secret',
    'sub\\..\\evil',
    'null\0byte_agent'
  ];

  const reservedDosDevices = [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM9',
    'LPT1',
    'LPT9',
    'CONIN$',
    'CONOUT$',
    'CLOCK$',
    'CON.txt',
    'aux.json',
    'nul.dat'
  ];

  const maliciousInputs = [...traversalPayloads, ...reservedDosDevices];

  const sampleEnvelope = MessageEnvelope.create({
    sender: 'security_fuzzer',
    recipient: 'valid_target',
    type: 'task_dispatch',
    payload: { test: true }
  });

  for (const input of maliciousInputs) {
    // 1. validateAgentName
    assert.throws(
      () => validateAgentName(input),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `validateAgentName should reject: "${input}"`
    );

    // 2. writeMessage
    await assert.rejects(
      async () => await writeMessage(input, sampleEnvelope),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `writeMessage should reject: "${input}"`
    );

    // 3. readInbox (async)
    assert.throws(
      () => readInbox(input),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `readInbox should reject: "${input}"`
    );

    // 4. readInboxSync
    assert.throws(
      () => readInboxSync(input),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `readInboxSync should reject: "${input}"`
    );

    // 5. ackMessage
    await assert.rejects(
      async () => await ackMessage(input, 'dummy-id'),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `ackMessage should reject: "${input}"`
    );

    // 6. clearInbox
    await assert.rejects(
      async () => await clearInbox(input),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `clearInbox should reject: "${input}"`
    );

    // 7. clearInboxSync
    assert.throws(
      () => clearInboxSync(input),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `clearInboxSync should reject: "${input}"`
    );

    // 8. registerAgent
    await assert.rejects(
      async () => await registerAgent({ name: input }),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `registerAgent should reject: "${input}"`
    );

    // 9. interruptAgent
    await assert.rejects(
      async () => await interruptAgent(input, 'Test interrupt attack', { mode: 'mesh' }),
      (err) => err instanceof SecurityError || err.name === 'SecurityError',
      `interruptAgent should reject: "${input}"`
    );
  }
});

// -----------------------------------------------------------------------------
// TIER 3 & 5: CORRUPT PACKET RESILIENCE
// -----------------------------------------------------------------------------

test('Tier 5 Resilience: Corrupt / malformed JSON packets in inbox directory are safely skipped without reader crashing', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-adv-res-corrupt-');
  const recipient = 'resilience_agent_' + Date.now();
  await clearInbox(recipient);

  const inboxDir = getInboxDir(recipient);
  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  // 1. Write 2 valid envelopes
  const valid1 = MessageEnvelope.create({
    sender: 'author_1',
    recipient,
    type: 'task_dispatch',
    payload: { seq: 1, text: 'First valid packet' }
  });
  const valid2 = MessageEnvelope.create({
    sender: 'author_2',
    recipient,
    type: 'task_dispatch',
    payload: { seq: 2, text: 'Second valid packet' }
  });

  await writeMessage(recipient, valid1);
  await writeMessage(recipient, valid2);

  // 2. Inject 3 corrupted files directly into the inbox directory
  // Corrupt 1: Truncated JSON
  fs.writeFileSync(path.join(inboxDir, '9999999999000_corrupt1.json'), '{"id": "bad", "unclosed": ', 'utf8');
  // Corrupt 2: Pure non-JSON garbage string
  fs.writeFileSync(path.join(inboxDir, '9999999999001_corrupt2.json'), '<<<MALFORMED_BINARY_RAW_CONTENT>>>', 'utf8');
  // Corrupt 3: Completely empty file
  fs.writeFileSync(path.join(inboxDir, '9999999999002_corrupt3.json'), '', 'utf8');

  // Verify 5 files exist on disk
  const filesOnDisk = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
  assert.strictEqual(filesOnDisk.length, 5);

  // 3. Test readInboxSync skips corrupted files safely
  let syncMsgs;
  assert.doesNotThrow(() => {
    syncMsgs = readInboxSync(recipient);
  }, 'readInboxSync must never throw on corrupted JSON files');

  assert.strictEqual(syncMsgs.length, 2, 'Should skip corrupted files and return exactly 2 valid envelopes');
  const syncIds = new Set(syncMsgs.map(m => m.id));
  assert.ok(syncIds.has(valid1.id), 'Inbox must contain valid1');
  assert.ok(syncIds.has(valid2.id), 'Inbox must contain valid2');

  // 4. Test async readInbox skips corrupted files safely
  let asyncMsgs;
  await assert.doesNotReject(async () => {
    asyncMsgs = await readInbox(recipient);
  }, 'readInbox must never reject on corrupted JSON files');

  assert.strictEqual(asyncMsgs.length, 2);
  const asyncTexts = new Set(asyncMsgs.map(m => m.payload.text));
  assert.ok(asyncTexts.has('First valid packet'), 'Inbox must contain first valid text');
  assert.ok(asyncTexts.has('Second valid packet'), 'Inbox must contain second valid text');

  // Clean up
  await clearInbox(recipient);
});

// -----------------------------------------------------------------------------
// TIER 3 & 5: ZERO-KILL INVARIANT & SAFE ACTION RESOLUTION
// -----------------------------------------------------------------------------

test('Tier 5 Invariant: Zero-Kill protocol strictly blocks illegal terminations and resolves to resume/message', () => {
  const illegalActions = ['kill', 'terminate', 'destroy', 'KILL', 'Terminate', 'DESTROY'];
  const protectedStates = ['RUNNING', 'STOPPED', 'PAUSED', 'IDLE'];

  for (const act of illegalActions) {
    for (const status of protectedStates) {
      const agentState = { name: 'target_subagent', status };

      // 1. verifyZeroKill throws GovernanceViolationError
      assert.throws(
        () => verifyZeroKill(act, agentState),
        (err) => err instanceof GovernanceViolationError && err.name === 'GovernanceViolationError',
        `verifyZeroKill must throw GovernanceViolationError on action "${act}" with status "${status}"`
      );

      // 2. validateAgentAction alias throws GovernanceViolationError
      assert.throws(
        () => validateAgentAction(act, agentState),
        (err) => err instanceof GovernanceViolationError && err.name === 'GovernanceViolationError',
        `validateAgentAction must throw GovernanceViolationError on action "${act}" with status "${status}"`
      );

      // 3. resolveSafeAction safely converts termination into non-destructive commands
      const resolution = resolveSafeAction(act, agentState);
      assert.strictEqual(resolution.safe, true);

      if (status === 'STOPPED' || status === 'PAUSED') {
        assert.strictEqual(
          resolution.resolvedAction,
          'resume',
          `Stopped/Paused agent should be resolved to "resume"`
        );
      } else {
        assert.strictEqual(
          resolution.resolvedAction,
          'message',
          `Running/Idle agent should be resolved to "message"`
        );
      }
    }
  }

  // Permitted compliant actions pass without throwing
  const compliantActions = ['resume', 'message', 'status', 'inspect', 'heartbeat'];
  for (const act of compliantActions) {
    assert.doesNotThrow(() => {
      verifyZeroKill(act, { status: 'RUNNING' });
      validateAgentAction(act, { status: 'STOPPED' });
    });

    const res = resolveSafeAction(act, { status: 'RUNNING' });
    assert.strictEqual(res.resolvedAction, act);
  }
});
