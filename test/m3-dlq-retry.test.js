/**
 * test/m3-dlq-retry.test.js
 *
 * Milestone 3 Suite 6: Dead-Letter Auto-Retry Daemon & Exponential Backoff (#69).
 * Validates discrete DLQ message retry scheduling, transient vs fatal classification,
 * backoff math with jitter, max retry bounding, and poison queue handling.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { writeMessage, readInbox } = require('../src/core/mesh');
const { DlqRetryDaemon } = require('../src/core/dlq-retry');

describe('Milestone 3 Suite 6: Dead-Letter Auto-Retry Daemon (#69)', () => {
  let daemon;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlq-retry-m3-test-'));
    process.env.INTERCOM_MESH_DIR = tempDir;
    daemon = new DlqRetryDaemon(tempDir, { maxRetries: 3, baseDelayMs: 20, maxDelayMs: 500 });
  });

  afterEach(() => {
    delete process.env.INTERCOM_MESH_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // #69: Error Classification: Transient vs Fatal
  test('#69: Error classifier distinguishes transient retryable errors from permanent fatal violations', () => {
    // Transient codes: EBUSY, ETIMEDOUT, 503_OVERLOAD, RATE_LIMITED
    assert.equal(daemon.isTransientError('EBUSY: resource locked on Windows'), true);
    assert.equal(daemon.isTransientError('Connection ETIMEDOUT to gateway'), true);
    assert.equal(daemon.isTransientError('HTTP 503_OVERLOAD server busy'), true);
    assert.equal(daemon.isTransientError('RATE_LIMITED 429 quota reached'), true);

    // Fatal codes: INVALID_SCHEMA, SECURITY_VIOLATION, MALFORMED_JSON
    assert.equal(daemon.isTransientError('INVALID_SCHEMA missing required fields'), false);
    assert.equal(daemon.isTransientError('SECURITY_VIOLATION path traversal attack'), false);
    assert.equal(daemon.isTransientError('MALFORMED_JSON syntax error at line 1'), false);
  });

  // #69: Exponential Backoff & Jitter Schedule
  test('#69: Calculates exponential backoff with jitter and respects maxDelayMs ceiling', () => {
    const delay0 = daemon.calculateBackoff(0); // ~20ms + jitter
    assert.ok(delay0 >= 20 && delay0 <= 35, `delay0 (${delay0}) within range [20, 35]`);

    const delay1 = daemon.calculateBackoff(1); // ~40ms + jitter
    assert.ok(delay1 >= 40 && delay1 <= 55, `delay1 (${delay1}) within range [40, 55]`);

    const delay2 = daemon.calculateBackoff(2); // ~80ms + jitter
    assert.ok(delay2 >= 80 && delay2 <= 95, `delay2 (${delay2}) within range [80, 95]`);

    // High attempt clamped to maxDelayMs = 500
    const delayMax = daemon.calculateBackoff(10);
    assert.equal(delayMax, 500, 'Backoff must clamp to maxDelayMs');

    // NaN or non-finite attempt safely falls back to base delay
    const delayNaN = daemon.calculateBackoff(NaN);
    assert.ok(delayNaN >= 20 && delayNaN <= 35, 'NaN retryCount safely falls back to base attempt');
  });

  // #69: Successful Transient Retry
  test('#69: Transient dead-letter messages are retried successfully and removed from DLQ', async () => {
    const recipient = 'worker_recovered_' + crypto.randomUUID().slice(0, 6);
    const dlqId = 'dlq_transient_' + crypto.randomUUID().slice(0, 6);
    daemon.enqueueDeadLetter({
      id: dlqId,
      recipient,
      sender: 'orchestrator',
      lastError: 'EBUSY: file lock contention',
      payload: { job: 'reprocess_artifact' }
    });

    assert.equal(fs.existsSync(path.join(daemon.dlqDir, `${dlqId}.json`)), true);

    // Process DLQ
    await daemon.processDlqOnce();

    // Verify successfully retried and unlinked
    assert.equal(fs.existsSync(path.join(daemon.dlqDir, `${dlqId}.json`)), false);
    assert.equal(daemon.stats.retried, 1);

    // Verify delivered to recipient inbox
    const inbox = await readInbox(recipient, { limit: 10 });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].payload.job, 'reprocess_artifact');
  });

  // #69: Fatal Error Immediate Poisoning
  test('#69: Permanent fatal errors are moved to poison queue immediately without wasting retries', async () => {
    daemon.enqueueDeadLetter({
      id: 'dlq_fatal_01',
      recipient: 'target_agent',
      lastError: 'SECURITY_VIOLATION: path traversal attempted',
      payload: { attack: true }
    });

    await daemon.processDlqOnce();

    // Must be removed from active dlq and placed in poison
    assert.equal(fs.existsSync(path.join(daemon.dlqDir, 'dlq_fatal_01.json')), false);
    assert.equal(fs.existsSync(path.join(daemon.poisonDir, 'dlq_fatal_01.json')), true);
    assert.equal(daemon.stats.poisoned, 1);
    assert.equal(daemon.stats.retried, 0);
  });

  // #69: Max Retries Exhaustion
  test('#69: Transient message exceeding maxRetries is relocated to poison directory', async () => {
    daemon.enqueueDeadLetter({
      id: 'dlq_exhausted_01',
      recipient: 'stubborn_agent',
      lastError: 'ETIMEDOUT: upstream host unresponsive',
      retryCount: 3, // Already at maxRetries = 3
      payload: { persistent: true }
    });

    await daemon.processDlqOnce();

    assert.equal(fs.existsSync(path.join(daemon.dlqDir, 'dlq_exhausted_01.json')), false);
    assert.equal(fs.existsSync(path.join(daemon.poisonDir, 'dlq_exhausted_01.json')), true);
    assert.equal(daemon.stats.poisoned, 1);
  });
});
