/**
 * test/m3-session-sync.test.js
 *
 * Milestone 3 Suite 8: Multi-Harness Session Ledger Sync & Safe Windows Path Sanitization.
 * Validates Improvements:
 * - #72: Multi-harness session ledger sync across harnesses, IDEs, and global mesh
 * - #73: Rigorous Windows path traversal sanitizer, DOS device rejection & jail enforcement
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  validateAgentName,
  sanitizeAgentName,
  resolveSafePath,
  SecurityError
} = require('../src/core/mesh');
const { SessionLedgerSync } = require('../src/core/session-sync');

describe('Milestone 3 Suite 8: Session Ledger Sync & Path Sanitization (#72, #73)', () => {
  let tempDir;
  let ledger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-m3-test-'));
    process.env.INTERCOM_MESH_DIR = tempDir;
    ledger = new SessionLedgerSync(tempDir);
  });

  afterEach(() => {
    delete process.env.INTERCOM_MESH_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // #72: Session Ledger Persistence & Conflict Resolution
  test('#72: Synchronizes multi-harness sessions and resolves update conflicts via timestamp precedence', () => {
    // 1. Initial session record from OpenCode
    const s1 = ledger.recordSession({
      sessionId: 'sess_global_01',
      harness: 'opencode',
      model: 'glm-5.3-flash-free',
      status: 'active',
      taskCount: 1,
      createdAt: '2026-11-01T10:00:00Z',
      updatedAt: '2026-11-01T10:00:00Z'
    });

    assert.equal(s1.sessionId, 'sess_global_01');
    assert.equal(s1.harness, 'opencode');

    // 2. Incoming update from EXdelegate with newer timestamp
    const s1Updated = ledger.recordSession({
      sessionId: 'sess_global_01',
      status: 'idle',
      taskCount: 3,
      updatedAt: '2026-11-01T10:15:00Z'
    });

    assert.equal(s1Updated.status, 'idle', 'Newer update must overwrite status');
    assert.equal(s1Updated.taskCount, 3);
    assert.equal(s1Updated.harness, 'opencode', 'Preserves original properties');

    // 3. Stale update with older timestamp must NOT overwrite newer state
    const staleAttempt = ledger.recordSession({
      sessionId: 'sess_global_01',
      status: 'active',
      updatedAt: '2026-11-01T10:05:00Z'
    });

    assert.equal(staleAttempt.status, 'idle', 'Stale update is rejected and newer state preserved');
  });

  // #72: Multi-Harness Session Listing & Filtering
  test('#72: Lists and filters session ledger by harness, status, and agent', () => {
    ledger.recordSession({ sessionId: 's_oc', harness: 'opencode', agent: 'worker', status: 'active', updatedAt: '2026-11-01T10:00:00Z' });
    ledger.recordSession({ sessionId: 's_cl', harness: 'claude', agent: 'reviewer', status: 'idle', updatedAt: '2026-11-01T10:01:00Z' });
    ledger.recordSession({ sessionId: 's_jl', harness: 'jules', agent: 'worker', status: 'idle', updatedAt: '2026-11-01T10:02:00Z' });

    // Filter by harness
    const opencodeSessions = ledger.listSessions({ harness: 'opencode' });
    assert.equal(opencodeSessions.length, 1);
    assert.equal(opencodeSessions[0].sessionId, 's_oc');

    // Filter by status
    const idleSessions = ledger.listSessions({ status: 'idle' });
    assert.equal(idleSessions.length, 2);

    // Filter by agent role
    const workerSessions = ledger.listSessions({ agent: 'worker' });
    assert.equal(workerSessions.length, 2);
  });

  // #73: Windows Safe Path Traversal Sanitizer
  test('#73: Rigorously rejects path traversal attacks, encoded tokens, and root breakouts', () => {
    const baseDir = path.join(tempDir, 'inbox');
    fs.mkdirSync(baseDir, { recursive: true });

    // 1. Valid safe name
    const valid = resolveSafePath(baseDir, 'valid_agent_01');
    assert.equal(valid, path.join(baseDir, 'valid_agent_01'));

    // 2. Traversal tokens rejection: ../ and ..\
    assert.throws(() => resolveSafePath(baseDir, '../outside'), SecurityError);
    assert.throws(() => resolveSafePath(baseDir, '..\\outside'), SecurityError);

    // 3. URL encoded traversal: %2e%2e, %2f, %5c
    assert.throws(() => resolveSafePath(baseDir, '%2e%2e/outside'), SecurityError);
    assert.throws(() => resolveSafePath(baseDir, 'agent%2fsub'), SecurityError);
    assert.throws(() => resolveSafePath(baseDir, 'agent%5csub'), SecurityError);

    // 4. validateAgentName rejects slashes and dots
    assert.throws(() => validateAgentName('../bad_agent'), SecurityError);
    assert.throws(() => validateAgentName('agent/sub'), SecurityError);
    assert.throws(() => validateAgentName('agent\\sub'), SecurityError);
  });

  // #73: Windows DOS Device & Special Device Rejection
  test('#73: Rigorously rejects reserved Windows DOS devices and extended device handles', () => {
    const reservedDevices = [
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
      'CONIN$', 'CONOUT$', 'CLOCK$',
      'con.txt', 'nul.json', 'aux.log'
    ];

    for (const dev of reservedDevices) {
      assert.throws(
        () => validateAgentName(dev),
        SecurityError,
        `Device '${dev}' must be rejected by validateAgentName`
      );
    }
  });

  // #73: Agent Name Safe Sanitization
  test('#73: sanitizeAgentName cleanses illegal characters, null bytes, and generates safe fallbacks', () => {
    // Null byte stripping
    assert.equal(sanitizeAgentName('agent\0name'), 'agentname');

    // Slashes and backslashes
    assert.equal(sanitizeAgentName('path/to\\agent'), 'agent');

    // DOS device fallback
    assert.equal(sanitizeAgentName('NUL'), 'NUL_safe');
    assert.equal(sanitizeAgentName('CON'), 'CON_safe');

    // Non-string fallback
    assert.equal(sanitizeAgentName(null), 'unknown');
    assert.equal(sanitizeAgentName(undefined), 'unknown');
  });
});
