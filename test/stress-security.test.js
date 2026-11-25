// test/stress-security.test.js - Adversarial Empirical Security Stress Harness
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  validateAgentName,
  resolveSafePath,
  writeMessage,
  ackMessage,
  getInboxDir,
  readInbox,
  readInboxSync,
  clearInbox,
  clearInboxSync,
  SecurityError
} = require('../src/core/mesh');
const { MessageEnvelope, validateMessage } = require('../src/core/message');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('Adversarial Security: Path traversal inputs strictly rejected by validateAgentName', () => {
  const maliciousTraversalInputs = [
    '../',
    '..\\',
    '%2e%2e',
    '%2E%2E',
    '/etc/passwd',
    'C:\\Windows\\System32',
    '../../etc/shadow',
    '..\\..\\secret.txt',
    '%2fetc%2fpasswd',
    '%5cwindows%5csystem32',
    'a/b',
    'a\\b',
    'agent/../../secret',
    'agent\\..\\..\\secret',
    '..',
    '.'
  ];

  let rejected = 0;
  for (const input of maliciousTraversalInputs) {
    assert.throws(
      () => validateAgentName(input),
      (err) => err instanceof SecurityError,
      `Expected SecurityError for path traversal input: "${input}"`
    );
    rejected++;
  }
  console.log(`[SECURITY STRESS] Path traversal tests passed: ${rejected}/${maliciousTraversalInputs.length} strictly rejected.`);
});

test('Adversarial Security: Extended Windows DOS device names strictly rejected by validateAgentName', () => {
  const dosDeviceInputs = [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM5',
    'COM9',
    'LPT1',
    'LPT5',
    'LPT9',
    'CONIN$',
    'CONOUT$',
    'CLOCK$',
    // Lowercase variants
    'con',
    'prn',
    'aux',
    'nul',
    'com1',
    'lpt1',
    'conin$',
    'conout$',
    'clock$',
    // Device names with arbitrary extensions
    'con.txt',
    'prn.json',
    'aux.dat',
    'nul.log',
    'COM1.bin',
    'LPT1.pdf',
    'CONIN$.dat',
    'CLOCK$.sys'
  ];

  let rejected = 0;
  for (const dev of dosDeviceInputs) {
    assert.throws(
      () => validateAgentName(dev),
      (err) => err instanceof SecurityError,
      `Expected SecurityError for DOS device name: "${dev}"`
    );
    rejected++;
  }
  console.log(`[SECURITY STRESS] Windows DOS device tests passed: ${rejected}/${dosDeviceInputs.length} strictly rejected.`);
});

test('Adversarial Security: resolveSafePath strictly enforces directory jail', (t) => {
  const { meshDir } = withIsolatedMeshEnv(t, 'intercom-stress-sec-');
  const baseDir = path.join(meshDir, 'inbox');
  const jailBreakInputs = [
    '../',
    '..\\',
    '../../etc/passwd',
    '..\\..\\windows\\system32',
    '%2e%2e',
    '%2froot',
    '%5csystem32'
  ];

  let jailRejections = 0;
  for (const input of jailBreakInputs) {
    assert.throws(
      () => resolveSafePath(baseDir, input),
      (err) => err instanceof SecurityError,
      `Expected SecurityError on jailbreak input: "${input}"`
    );
    jailRejections++;
  }
  console.log(`[SECURITY STRESS] Directory jail tests passed: ${jailRejections}/${jailBreakInputs.length} trapped.`);
});

test('Adversarial Security: writeMessage strictly rejects malicious recipients', async () => {
  const badRecipients = [
    '../',
    '..\\',
    '%2e%2e',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'LPT1',
    'CONIN$',
    'CONOUT$',
    'CLOCK$'
  ];

  let rejected = 0;
  for (const rec of badRecipients) {
    await assert.rejects(
      async () => {
        await writeMessage(rec, {
          sender: 'tester',
          recipient: 'dummy',
          type: 'task_dispatch',
          payload: { attack: true }
        });
      },
      (err) => err instanceof SecurityError,
      `writeMessage failed to reject malicious recipient: "${rec}"`
    );
    rejected++;
  }
  console.log(`[SECURITY STRESS] writeMessage recipient tests passed: ${rejected}/${badRecipients.length} strictly rejected.`);
});

test('Adversarial Security: readInbox and readInboxSync strictly reject malicious recipient names', () => {
  const badRecipients = [
    '../',
    '..\\',
    '../../etc/passwd',
    'CON',
    'PRN',
    'NUL',
    'CONIN$'
  ];

  for (const rec of badRecipients) {
    // Synchronous variant
    assert.throws(
      () => readInboxSync(rec),
      (err) => err instanceof SecurityError,
      `readInboxSync failed to reject malicious recipient: "${rec}"`
    );
    // Asynchronous wrapper
    assert.throws(
      () => readInbox(rec),
      (err) => err instanceof SecurityError,
      `readInbox failed to reject malicious recipient: "${rec}"`
    );
  }
  console.log('[SECURITY STRESS] readInbox and readInboxSync strict rejection verified.');
});

test('Adversarial Security: clearInbox and clearInboxSync strictly reject malicious agent names', async () => {
  const badAgents = [
    '../',
    '..\\',
    '../../victim',
    'CON',
    'PRN',
    'NUL',
    'CONIN$'
  ];

  for (const agent of badAgents) {
    // Synchronous variant
    assert.throws(
      () => clearInboxSync(agent),
      (err) => err instanceof SecurityError,
      `clearInboxSync failed to reject malicious agent: "${agent}"`
    );
    // Asynchronous variant
    await assert.rejects(
      async () => {
        await clearInbox(agent);
      },
      (err) => err instanceof SecurityError,
      `clearInbox failed to reject malicious agent: "${agent}"`
    );
  }
  console.log('[SECURITY STRESS] clearInbox and clearInboxSync strict rejection verified.');
});

test('Adversarial Security: MessageEnvelope schema strictly rejects Windows DOS device names', () => {
  const dosDevices = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1', 'CONIN$', 'CLOCK$'];

  for (const dev of dosDevices) {
    // Test as recipient
    const resRec = validateMessage({
      id: 'a1b2c3d4-e5f6-4789-8012-34567890abcd',
      timestamp: new Date().toISOString(),
      sender: 'valid_sender',
      recipient: dev,
      type: 'task_dispatch',
      priority: 'NORMAL',
      payload: {}
    });
    assert.strictEqual(resRec.valid, false, `validateMessage allowed DOS device recipient: "${dev}"`);
    assert.ok(resRec.errors.some(e => e.includes('reserved Windows DOS/Win32 device name')));

    // Test as sender
    const resSend = validateMessage({
      id: 'a1b2c3d4-e5f6-4789-8012-34567890abcd',
      timestamp: new Date().toISOString(),
      sender: dev,
      recipient: 'valid_recipient',
      type: 'task_dispatch',
      priority: 'NORMAL',
      payload: {}
    });
    assert.strictEqual(resSend.valid, false, `validateMessage allowed DOS device sender: "${dev}"`);
    assert.ok(resSend.errors.some(e => e.includes('reserved Windows DOS/Win32 device name')));
  }
  console.log('[SECURITY STRESS] MessageEnvelope schema DOS device rejection verified.');
});

test('Adversarial Security: ackMessage and getInboxDir strictly reject malicious agent names', async () => {
  const badAgents = ['../', '..\\', '%2e%2e', '/etc/passwd', 'CON', 'NUL', 'CONIN$'];

  for (const agent of badAgents) {
    assert.throws(
      () => getInboxDir(agent),
      (err) => err instanceof SecurityError,
      `getInboxDir failed to reject malicious agent: "${agent}"`
    );

    await assert.rejects(
      async () => {
        await ackMessage(agent, 'some-msg-id');
      },
      (err) => err instanceof SecurityError,
      `ackMessage failed to reject malicious agent: "${agent}"`
    );
  }
  console.log('[SECURITY STRESS] ackMessage and getInboxDir strict rejection verified.');
});
