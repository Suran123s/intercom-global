/**
 * test/m3-cross-handoff.test.js
 *
 * Milestone 3 Suite 4: Zero-Loss Atomic Cross-Agent Handoff Protocol (#66).
 * Validates transactional handoff state machine, bidirectional confirmation,
 * rejection fallback, and timeout safety without task or message loss.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { writeMessage, readInbox, clearInbox, HandoffCoordinator } = require('../src/core/mesh');

describe('Milestone 3 Suite 4: Zero-Loss Atomic Cross-Agent Handoff (#66)', () => {
  let tempDir;
  let coordinator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-m3-test-'));
    process.env.INTERCOM_MESH_DIR = tempDir;
    coordinator = new HandoffCoordinator(tempDir);
  });

  afterEach(() => {
    delete process.env.INTERCOM_MESH_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // #66: Happy Path: Complete Bidirectional Handoff
  test('#66: Transactional handoff progresses through INITIATED -> CONFIRMED -> COMPLETED with full state preservation', async () => {
    const sender = 'explorer_m3_1_' + crypto.randomUUID().slice(0, 6);
    const recipient = 'worker_m3_1_' + crypto.randomUUID().slice(0, 6);
    const taskId = 'task_feature_51_' + crypto.randomUUID().slice(0, 6);

    // Phase 1: Sender initiates handoff
    const handoff = await coordinator.initiateHandoff({
      sender,
      recipient,
      taskId,
      context: { astAnalysis: 'Verified AST diff structure', targetFiles: ['src/tui/diff-viewer.js'] }
    });

    assert.equal(handoff.status, 'INITIATED');
    assert.equal(handoff.sender, sender);
    assert.equal(handoff.recipient, recipient);

    // Verify recipient received handoff request in discrete mailbox
    const recipientInbox = await readInbox(recipient, { limit: 10 });
    assert.equal(recipientInbox.length, 1);
    assert.equal(recipientInbox[0].payload.action, 'handoff_request');
    assert.equal(recipientInbox[0].payload.handoffId, handoff.handoffId);

    // Phase 2: Recipient confirms receipt
    const confirmed = await coordinator.confirmHandoff(handoff.handoffId, recipient, { assignedWorkerPid: 4242 });
    assert.equal(confirmed.status, 'CONFIRMED');
    assert.ok(confirmed.confirmedAt);

    // Verify sender received handoff_ack
    const senderInbox = await readInbox(sender, { limit: 10 });
    assert.equal(senderInbox.length, 1);
    assert.equal(senderInbox[0].type, 'ack');
    assert.equal(senderInbox[0].payload.action, 'handoff_ack');
    assert.equal(senderInbox[0].payload.status, 'CONFIRMED');

    // Phase 3: Sender completes and releases task ownership
    const completed = coordinator.completeHandoff(handoff.handoffId, sender);
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(completed.completedAt);
  });

  // #66: Rejection Fallback: Sender Retains Task
  test('#66: Recipient rejection transitions state to REJECTED and sender retains task ownership without loss', async () => {
    const sender = 'reviewer_m3_' + crypto.randomUUID().slice(0, 6);
    const recipient = 'auditor_m3_' + crypto.randomUUID().slice(0, 6);
    const taskId = 'task_audit_security_' + crypto.randomUUID().slice(0, 6);

    const handoff = await coordinator.initiateHandoff({
      sender,
      recipient,
      taskId,
      context: { priority: 'URGENT' }
    });

    // Recipient rejects due to queue saturation
    const rejected = await coordinator.rejectHandoff(handoff.handoffId, recipient, 'Queue depth limit exceeded');
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.rejectReason, 'Queue depth limit exceeded');

    // Verify sender received NACK notification to resume ownership
    const senderInbox = await readInbox(sender, { limit: 10 });
    const nack = senderInbox.find((m) => m.payload.action === 'handoff_nack');
    assert.ok(nack, 'Sender must receive handoff_nack');
    assert.equal(nack.payload.reason, 'Queue depth limit exceeded');

    // Sender cannot mark rejected handoff as COMPLETED
    assert.throws(
      () => coordinator.completeHandoff(handoff.handoffId, sender),
      /Cannot complete unconfirmed handoff/i
    );
  });

  // #66: Unauthorized Confirmation Security Check
  test('#66: Unauthorized agent cannot confirm or complete handoff assigned to another agent', async () => {
    const sender = 'worker_alpha_' + crypto.randomUUID().slice(0, 6);
    const recipient = 'worker_beta_' + crypto.randomUUID().slice(0, 6);

    const handoff = await coordinator.initiateHandoff({
      sender,
      recipient,
      taskId: 'task_secure_01'
    });

    // Rogue agent attempts to confirm
    await assert.rejects(
      async () => await coordinator.confirmHandoff(handoff.handoffId, 'rogue_agent'),
      /Unauthorized recipient/i
    );

    // Rogue sender attempts to complete
    assert.throws(
      () => coordinator.completeHandoff(handoff.handoffId, 'rogue_sender'),
      /Unauthorized sender/i
    );
  });

  // #66: Expired Handoff Handling
  test('#66: Expired handoff transitions to TIMED_OUT and prevents stale task adoption', async () => {
    const handoff = await coordinator.initiateHandoff({
      sender: 'agent_a',
      recipient: 'agent_b',
      taskId: 'task_timeout',
      timeoutMs: 50 // 50ms short expiration
    });

    // Wait for timeout to elapse
    await new Promise((r) => setTimeout(r, 65));

    await assert.rejects(
      async () => await coordinator.confirmHandoff(handoff.handoffId, 'agent_b'),
      /expired/i
    );

    const record = coordinator.getHandoff(handoff.handoffId);
    assert.equal(record.status, 'TIMED_OUT');
  });
});
