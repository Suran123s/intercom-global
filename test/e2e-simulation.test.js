// test/e2e-simulation.test.js - Tier 4 Multi-IDE End-to-End Simulation Test Suite
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { MessageEnvelope } = require('../src/core/message');
const {
  writeMessage,
  readInbox,
  readInboxSync,
  ackMessage,
  clearInbox,
  clearInboxSync
} = require('../src/core/mesh');
const {
  registerAgent,
  unregisterAgent,
  getAgentState,
  listActiveAgents,
  touchHeartbeat
} = require('../src/core/registry');
const {
  interruptAgent,
  hasInterruptFlag,
  consumeInterruptFlag
} = require('../src/core/interrupter');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('Tier 4 Multi-IDE: Parent <-> Child task dispatch and correlated response delivery across simulated IDEs', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-e2e-sim-1-');
  const parentName = 'orchestrator_antigravity_' + Date.now();
  const childName = 'worker_cursor_' + Date.now();

  await clearInbox(parentName);
  await clearInbox(childName);

  try {
    // 1. Register simulated multi-IDE agents
    const parentCard = await registerAgent({
      name: parentName,
      ide: 'antigravity',
      role: 'coordinator',
      capabilities: ['planning', 'task_dispatch', 'supervision'],
      pid: process.pid
    });

    const childCard = await registerAgent({
      name: childName,
      ide: 'cursor',
      role: 'worker',
      capabilities: ['code_generation', 'unit_testing', 'refactoring'],
      pid: process.pid
    });

    assert.strictEqual(parentCard.ide, 'antigravity');
    assert.strictEqual(childCard.ide, 'cursor');

    // 2. Parent dispatches task to Child
    const correlationId = 'corr_' + Date.now() + '_xyz';
    const parentId = 'sess_' + Date.now() + '_root';

    const dispatchEnvelope = MessageEnvelope.create({
      sender: parentName,
      recipient: childName,
      type: 'task_dispatch',
      priority: 'HIGH',
      payload: {
        task: 'Implement Zero-Kill and Bounded Reuse Governance',
        milestone: 'Milestone 4',
        spec: 'PROJECT.md'
      },
      correlationId,
      parentId
    });

    const sendRes = await writeMessage(childName, dispatchEnvelope);
    assert.ok(sendRes.messageId);
    assert.ok(fs.existsSync(sendRes.path));

    // 3. Child receives message in inbox
    const childInbox = await readInbox(childName);
    assert.strictEqual(childInbox.length, 1);
    assert.strictEqual(childInbox[0].sender, parentName);
    assert.strictEqual(childInbox[0].correlationId, correlationId);
    assert.strictEqual(childInbox[0].parentId, parentId);
    assert.strictEqual(childInbox[0].payload.milestone, 'Milestone 4');

    // Child acknowledges receipt
    const ackReceived = await ackMessage(childName, childInbox[0].id);
    assert.strictEqual(ackReceived, true);

    const childInboxAfterAck = await readInbox(childName);
    assert.strictEqual(childInboxAfterAck.length, 0);

    // 4. Child executes work and returns correlated task_response
    const responseEnvelope = MessageEnvelope.create({
      sender: childName,
      recipient: parentName,
      type: 'task_response',
      priority: 'NORMAL',
      payload: {
        status: 'COMPLETED',
        milestone: 'Milestone 4',
        testsPassed: 42,
        durationMs: 850
      },
      correlationId,
      parentId
    });

    const respSendRes = await writeMessage(parentName, responseEnvelope);
    assert.ok(respSendRes.messageId);

    // 5. Parent receives and validates correlated response
    const parentInbox = await readInbox(parentName);
    assert.strictEqual(parentInbox.length, 1);
    assert.strictEqual(parentInbox[0].sender, childName);
    assert.strictEqual(parentInbox[0].correlationId, correlationId);
    assert.strictEqual(parentInbox[0].parentId, parentId);
    assert.strictEqual(parentInbox[0].type, 'task_response');
    assert.strictEqual(parentInbox[0].payload.status, 'COMPLETED');
    assert.strictEqual(parentInbox[0].payload.testsPassed, 42);

    // Parent acknowledges and archives
    const ackFinal = await ackMessage(parentName, parentInbox[0].id);
    assert.strictEqual(ackFinal, true);

    const parentInboxAfterAck = await readInbox(parentName);
    assert.strictEqual(parentInboxAfterAck.length, 0);
  } finally {
    await clearInbox(parentName);
    await clearInbox(childName);
    await unregisterAgent(parentName, true);
    await unregisterAgent(childName, true);
  }
});

test('Tier 4 Multi-IDE: Multi-agent discovery via Agent State Cards across OpenCode, Qoder, and Cursor', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-e2e-sim-2-');
  const ts = Date.now();
  const agent1 = 'reviewer_opencode_' + ts;
  const agent2 = 'auditor_qoder_' + ts;
  const agent3 = 'worker_cursor_' + ts;

  try {
    await registerAgent({
      name: agent1,
      ide: 'opencode',
      role: 'reviewer',
      capabilities: ['code_review', 'ast_inspection']
    });

    await registerAgent({
      name: agent2,
      ide: 'qoder',
      role: 'auditor',
      capabilities: ['security_audit', 'fuzzing', 'forensics']
    });

    await registerAgent({
      name: agent3,
      ide: 'cursor',
      role: 'worker',
      capabilities: ['implementation', 'testing']
    });

    // 1. List active agents and check registrations
    const all = await listActiveAgents();
    assert.ok(all.some(a => a.name === agent1 && a.ide === 'opencode' && a.role === 'reviewer'));
    assert.ok(all.some(a => a.name === agent2 && a.ide === 'qoder' && a.role === 'auditor'));
    assert.ok(all.some(a => a.name === agent3 && a.ide === 'cursor' && a.role === 'worker'));

    // 2. Query individual Agent State Cards
    const card1 = await getAgentState(agent1);
    assert.strictEqual(card1.name, agent1);
    assert.strictEqual(card1.ide, 'opencode');
    assert.deepStrictEqual(card1.capabilities, ['code_review', 'ast_inspection']);

    const card2 = await getAgentState(agent2);
    assert.strictEqual(card2.name, agent2);
    assert.strictEqual(card2.ide, 'qoder');
    assert.deepStrictEqual(card2.capabilities, ['security_audit', 'fuzzing', 'forensics']);

    // 3. Heartbeat update
    const prevHb = card1.lastHeartbeat;
    await new Promise(r => setTimeout(r, 15));
    const touched = await touchHeartbeat(agent1);
    assert.notStrictEqual(touched.lastHeartbeat, prevHb);
  } finally {
    await unregisterAgent(agent1, true);
    await unregisterAgent(agent2, true);
    await unregisterAgent(agent3, true);
  }
});

test('Tier 4 Multi-IDE: Live agent interruption during active execution with 0 dropped messages', async (t) => {
  withIsolatedMeshEnv(t, 'intercom-e2e-sim-3-');
  const target = 'active_worker_' + Date.now();
  await clearInbox(target);

  try {
    // 1. Send normal task
    const initialEnv = MessageEnvelope.create({
      sender: 'supervisor',
      recipient: target,
      type: 'task_dispatch',
      priority: 'NORMAL',
      payload: { step: 1, action: 'compiling_large_module' }
    });
    await writeMessage(target, initialEnv);

    // 2. Issue live 3-tier interruption
    const interruptResult = await interruptAgent(target, 'Immediate halt: regression detected in downstream module', {
      mode: 'auto'
    });

    assert.strictEqual(interruptResult.interrupted, true);
    assert.ok(interruptResult.method.includes('safe_path_envelope'));

    // Verify flag
    assert.strictEqual(hasInterruptFlag(target), true);

    // 3. Check inbox: normal message and high-priority interrupt envelope must both be preserved (0 lost messages)
    const inbox = await readInbox(target);
    assert.strictEqual(inbox.length, 2);

    // The messages must be sorted chronologically
    assert.strictEqual(inbox[0].type, 'task_dispatch');
    assert.strictEqual(inbox[0].payload.step, 1);

    assert.strictEqual(inbox[1].type, 'interrupt');
    assert.strictEqual(inbox[1].priority, 'CRITICAL');
    assert.strictEqual(inbox[1].payload.action, 'ABORT_ACTIVE_TASK');
    assert.ok(inbox[1].payload.reason.includes('regression detected'));

    // 4. Consume flag
    const flag = await consumeInterruptFlag(target);
    assert.ok(flag);
    assert.strictEqual(flag.target, target);
    assert.strictEqual(hasInterruptFlag(target), false);
  } finally {
    await clearInbox(target);
  }
});
