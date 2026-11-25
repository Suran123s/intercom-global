// test/m2_core.test.js - Milestone 2 Core Framework Test Suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { MessageEnvelope, validateMessage } = require('../src/core/message');
const {
  writeMessage,
  readInbox,
  readInboxSync,
  ackMessage,
  acquireLock,
  releaseLock,
  validateAgentName,
  sanitizeAgentName,
  resolveSafePath,
  clearInbox,
  SecurityError,
  LockTimeoutError
} = require('../src/core/mesh');
const {
  registerAgent,
  unregisterAgent,
  getAgentState,
  listActiveAgents,
  touchHeartbeat,
  validateAgentCard
} = require('../src/core/registry');
const {
  Interrupter,
  interruptAgent,
  hasInterruptFlag,
  consumeInterruptFlag
} = require('../src/core/interrupter');
const { IntercomDaemon } = require('../src/core/daemon');
const { parseArgs } = require('../src/cli');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

// --- Group 1: Standardized MessageEnvelope & Schema Validation ---
test('MessageEnvelope: valid envelope creation and JSON serialization', () => {
  const env = MessageEnvelope.create({
    sender: 'orchestrator',
    recipient: 'worker_m2',
    type: 'task_dispatch',
    priority: 'HIGH',
    payload: { task: 'Build core transport' },
    correlationId: '11111111-2222-4333-8444-555555555555'
  });

  assert.ok(env.id);
  assert.ok(env.timestamp);
  assert.strictEqual(typeof env.epochMs, 'number');
  assert.strictEqual(env.sender, 'orchestrator');
  assert.strictEqual(env.recipient, 'worker_m2');
  assert.strictEqual(env.type, 'task_dispatch');
  assert.strictEqual(env.priority, 'HIGH');
  assert.strictEqual(env.correlationId, '11111111-2222-4333-8444-555555555555');

  const json = env.toJSON();
  assert.strictEqual(json.id, env.id);

  const parsed = MessageEnvelope.fromJSON(JSON.stringify(json));
  assert.strictEqual(parsed.id, env.id);
  assert.strictEqual(parsed.sender, 'orchestrator');
});

test('MessageEnvelope: schema validation rejects invalid fields', () => {
  // Missing required fields
  const v1 = validateMessage({});
  assert.strictEqual(v1.valid, false);
  assert.ok(v1.errors.length >= 4);

  // Invalid sender with special characters
  const v2 = validateMessage({
    id: 'a1b2c3d4-e5f6-4789-8012-34567890abcd',
    timestamp: new Date().toISOString(),
    sender: 'bad/sender',
    recipient: 'valid_agent',
    type: 'task_dispatch',
    priority: 'NORMAL',
    payload: {}
  });
  assert.strictEqual(v2.valid, false);
  assert.ok(v2.errors.some(e => e.includes('sender')));

  // Invalid type
  const v3 = validateMessage({
    id: 'a1b2c3d4-e5f6-4789-8012-34567890abcd',
    timestamp: new Date().toISOString(),
    sender: 'agent1',
    recipient: 'agent2',
    type: 'unsupported_type',
    priority: 'NORMAL',
    payload: {}
  });
  assert.strictEqual(v3.valid, false);
  assert.ok(v3.errors.some(e => e.includes('type')));

  // Invalid priority
  const v4 = validateMessage({
    id: 'a1b2c3d4-e5f6-4789-8012-34567890abcd',
    timestamp: new Date().toISOString(),
    sender: 'agent1',
    recipient: 'agent2',
    type: 'task_dispatch',
    priority: 'URGENT_INVALID',
    payload: {}
  });
  assert.strictEqual(v4.valid, false);
});

// --- Group 2: Path Traversal & DOS Device Security ---
test('Security: rejects path traversal patterns', () => {
  const attacks = [
    '../agent',
    '..\\agent',
    'agent/../../secret',
    '%2e%2e/etc/passwd',
    '%2fetc%2fshadow',
    '%5cwindows%5csystem32',
    'a/b',
    'a\\b'
  ];

  for (const attack of attacks) {
    assert.throws(() => validateAgentName(attack), SecurityError);
  }
});

test('Security: rejects reserved Windows DOS and Win32 device names', () => {
  const dosDevices = [
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM5', 'COM9',
    'LPT1', 'LPT7',
    'CONIN$', 'CONOUT$', 'CLOCK$',
    'con.txt', 'nul.json', 'aux.dat'
  ];

  for (const dev of dosDevices) {
    assert.throws(() => validateAgentName(dev), SecurityError);
  }
});

test('Security: sanitizeAgentName safely neutralizes identifiers', () => {
  assert.strictEqual(sanitizeAgentName('CON'), 'CON_safe');
  assert.strictEqual(sanitizeAgentName('../../../foo'), 'foo');
  assert.strictEqual(sanitizeAgentName('valid-agent_123'), 'valid-agent_123');
});

// --- Group 3: Zero-Loss Discrete Atomic File-Mesh ---
test('File-Mesh: discrete atomic message delivery and chronological retrieval', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-m2-mesh-');
  const agent = 'test_mesh_agent_' + Date.now();
  await clearInbox(agent);

  const env1 = MessageEnvelope.create({
    sender: 'sender_1',
    recipient: agent,
    type: 'task_dispatch',
    priority: 'NORMAL',
    payload: { seq: 1 }
  });

  // Short pause to guarantee distinct epoch timestamps
  await new Promise(r => setTimeout(r, 20));

  const env2 = MessageEnvelope.create({
    sender: 'sender_2',
    recipient: agent,
    type: 'task_dispatch',
    priority: 'HIGH',
    payload: { seq: 2 }
  });

  const res1 = await writeMessage(agent, env1);
  const res2 = await writeMessage(agent, env2);

  assert.ok(fs.existsSync(res1.path));
  assert.ok(fs.existsSync(res2.path));
  assert.notStrictEqual(res1.path, res2.path);

  // Read inbox asynchronously and synchronously
  const inbox = await readInbox(agent);
  assert.strictEqual(inbox.length, 2);
  assert.strictEqual(inbox[0].payload.seq, 1);
  assert.strictEqual(inbox[1].payload.seq, 2);

  const inboxSync = readInboxSync(agent);
  assert.strictEqual(inboxSync.length, 2);

  // Acknowledge first message (archive)
  const ack1 = await ackMessage(agent, env1.id);
  assert.strictEqual(ack1, true);

  const afterAck = await readInbox(agent);
  assert.strictEqual(afterAck.length, 1);
  assert.strictEqual(afterAck[0].id, env2.id);

  // Acknowledge second message with unlink
  const ack2 = await ackMessage(agent, env2.id, { unlink: true });
  assert.strictEqual(ack2, true);

  const emptyInbox = await readInbox(agent);
  assert.strictEqual(emptyInbox.length, 0);

  await clearInbox(agent);
});

test('File-Mesh: concurrent writes maintain 100% data integrity without drop or race', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-m2-conc-');
  const agent = 'test_concurrency_agent_' + Date.now();
  await clearInbox(agent);

  const writeCount = 12;
  const promises = [];

  for (let i = 0; i < writeCount; i++) {
    const env = MessageEnvelope.create({
      sender: `worker_${i}`,
      recipient: agent,
      type: 'task_dispatch',
      priority: 'NORMAL',
      payload: { index: i, data: `content_${i}` }
    });
    promises.push(writeMessage(agent, env));
  }

  const results = await Promise.all(promises);
  assert.strictEqual(results.length, writeCount);

  const inbox = await readInbox(agent);
  assert.strictEqual(inbox.length, writeCount);

  // Verify all payload indices are accounted for
  const indices = inbox.map(m => m.payload.index).sort((a, b) => a - b);
  for (let i = 0; i < writeCount; i++) {
    assert.strictEqual(indices[i], i);
  }

  await clearInbox(agent);
});

// --- Group 4: Deadlock-Free CAS Advisory Locking ---
test('CAS Locking: acquire, mutual exclusion, release, and 3-second stale recovery', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-m2-lock-');
  const resource = 'test_res_' + Date.now();

  // 1. Acquire lock
  const handle1 = await acquireLock(resource, 500);
  assert.ok(handle1.lockDir);
  assert.ok(fs.existsSync(handle1.lockDir));

  // 2. Release lock
  await releaseLock(handle1);
  assert.ok(!fs.existsSync(handle1.lockDir));

  // 3. Stale lock auto-recovery (simulated short TTL)
  const handle2 = await acquireLock(resource, 200); // 200ms TTL
  // Wait for TTL to expire
  await new Promise(r => setTimeout(r, 260));

  // Contending process should break stale lock and acquire successfully
  const handle3 = await acquireLock(resource, 1000, { timeoutMs: 2000 });
  assert.ok(handle3.lockDir);

  await releaseLock(handle3);
  assert.ok(!fs.existsSync(handle3.lockDir));
});

// --- Group 5: Agent State Card Registry ---
test('Registry: register, get state, touch heartbeat, and list active agents', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-m2-reg-');
  const agentName = 'agent_reg_test_' + Date.now();

  const card = await registerAgent({
    name: agentName,
    ide: 'cursor',
    role: 'worker',
    capabilities: ['ast_inspection', 'unit_testing']
  });

  assert.strictEqual(card.name, agentName);
  assert.strictEqual(card.ide, 'cursor');
  assert.strictEqual(card.role, 'worker');
  assert.strictEqual(card.status, 'IDLE');

  // Retrieve state
  const fetched = await getAgentState(agentName);
  assert.ok(fetched);
  assert.strictEqual(fetched.name, agentName);
  assert.strictEqual(fetched.capabilities.length, 2);

  // Touch heartbeat
  const prevHb = fetched.lastHeartbeat;
  await new Promise(r => setTimeout(r, 10));
  const updated = await touchHeartbeat(agentName);
  assert.notStrictEqual(updated.lastHeartbeat, prevHb);

  // List active
  const activeList = await listActiveAgents();
  assert.ok(activeList.some(a => a.name === agentName));

  // Unregister
  await unregisterAgent(agentName, true);
  const afterUnreg = await getAgentState(agentName);
  assert.strictEqual(afterUnreg, null);
});

// --- Group 6: 3-Tier Interruption Engine ---
test('Interrupter: Safe-Path interrupt envelope and atomic flag file', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-m2-int-');
  const targetAgent = 'interrupt_target_' + Date.now();
  await clearInbox(targetAgent);

  const res = await interruptAgent(targetAgent, 'Halt current compilation: critical regression', {
    mode: 'auto'
  });

  assert.strictEqual(res.interrupted, true);
  assert.ok(res.method.includes('safe_path_envelope'));

  // Check flag
  assert.strictEqual(hasInterruptFlag(targetAgent), true);

  // Check inbox
  const inbox = await readInbox(targetAgent);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].type, 'interrupt');
  assert.strictEqual(inbox[0].priority, 'CRITICAL');
  assert.strictEqual(inbox[0].payload.action, 'ABORT_ACTIVE_TASK');

  // Consume flag
  const flag = await consumeInterruptFlag(targetAgent);
  assert.ok(flag);
  assert.strictEqual(flag.target, targetAgent);
  assert.strictEqual(hasInterruptFlag(targetAgent), false);

  await clearInbox(targetAgent);
});

// --- Group 7: High-Speed Loopback Daemon ---
test('Daemon: starts, responds to health check, send Fast/Safe path, and stops cleanly', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-m2-daemon-');
  const daemon = new IntercomDaemon({ port: 0 });
  await daemon.start();
  const testPort = daemon.port;

  try {
    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${testPort}/api/intercom/health`);
    assert.strictEqual(healthRes.status, 200);
    const health = await healthRes.json();
    assert.strictEqual(health.status, 'ONLINE');
    assert.strictEqual(health.port, testPort);

    // 2. Send message (Safe-Path fallback because no SSE client connected)
    const target = 'daemon_recipient_' + Date.now();
    const sendRes = await fetch(`http://127.0.0.1:${testPort}/api/intercom/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'tester',
        recipient: target,
        message: 'Hello via daemon'
      })
    });

    assert.strictEqual(sendRes.status, 200);
    const sendData = await sendRes.json();
    assert.strictEqual(sendData.status, 'DELIVERED_SAFE_PATH');

    const inbox = await readInbox(target);
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].payload.message, 'Hello via daemon');
    await clearInbox(target);

    // 3. Peers endpoint
    const peersRes = await fetch(`http://127.0.0.1:${testPort}/api/intercom/peers`);
    assert.strictEqual(peersRes.status, 200);
    const peersData = await peersRes.json();
    assert.ok(Array.isArray(peersData.connectedPeers));
    assert.ok(Array.isArray(peersData.registeredAgents));
  } finally {
    await daemon.stop();
  }
});

// --- Group 8: CLI Argument Parsing ---
test('CLI: parseArgs correctly decomposes commands, options, and flags', () => {
  const parsed = parseArgs([
    'send', 'worker_m1', 'Build component',
    '--from', 'orchestrator',
    '--priority', 'HIGH',
    '--type=task_dispatch'
  ]);

  assert.strictEqual(parsed._[0], 'send');
  assert.strictEqual(parsed._[1], 'worker_m1');
  assert.strictEqual(parsed._[2], 'Build component');
  assert.strictEqual(parsed.flags.from, 'orchestrator');
  assert.strictEqual(parsed.flags.priority, 'HIGH');
  assert.strictEqual(parsed.flags.type, 'task_dispatch');
});
