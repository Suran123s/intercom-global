/**
 * test/fuzz-payload.test.js
 *
 * Improvement #93: Message Payload Fuzzing Test Suite.
 * Validates message subsystem resiliency against adversarial, corrupted,
 * extreme-size, binary, and internationalized inputs:
 * - Corrupted, truncated, and malformed JSON files in inboxes
 * - Binary control bytes (\x00, \x01, \x1f) and Windows forbidden filename characters
 * - Huge payloads (multi-megabyte strings)
 * - Multi-byte Unicode, complex emojis (ZWJ sequences), and RTL scripts
 * - Deeply nested objects and exotic JSON types
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
  clearInbox,
  sanitizeWindowsFilename
} = require('../src/core/mesh');

describe('Milestone 4 — #93: Message Payload Fuzzing Test Suite', () => {
  const fuzzAgent = `fuzz-agent-${Date.now()}`;

  afterEach(async () => {
    try { await clearInbox(fuzzAgent); } catch {}
  });

  test('Fuzz 1: Malformed and Truncated JSON Files in Mailbox', async () => {
    const inboxDir = getInboxDir(fuzzAgent);

    // Drop corrupted JSON files into the mailbox directory
    fs.writeFileSync(path.join(inboxDir, '9999999999991_corrupt1.json'), '{"id": "partial', 'utf8');
    fs.writeFileSync(path.join(inboxDir, '9999999999992_corrupt2.json'), '', 'utf8'); // 0 bytes
    fs.writeFileSync(path.join(inboxDir, '9999999999993_corrupt3.json'), 'NOT_JSON_AT_ALL', 'utf8');
    fs.writeFileSync(path.join(inboxDir, '9999999999994_corrupt4.json'), 'null', 'utf8');

    // Also write one valid message
    await writeMessage(fuzzAgent, {
      sender: 'valid-sender',
      recipient: fuzzAgent,
      body: 'Valid message amongst corrupted files'
    });

    // readInbox must NOT throw; it should skip corrupted files and return the valid message
    let readResult;
    try {
      readResult = await readInbox(fuzzAgent);
    } catch (err) {
      assert.fail(`readInbox must not throw on corrupted inbox files: ${err.message}`);
    }

    assert.ok(readResult);
    assert.ok(readResult.length >= 1, 'Must successfully read the valid message');
    const valid = readResult.find((m) => {
      const text = m.payload?.message || m.payload?.body || m.body;
      return text === 'Valid message amongst corrupted files';
    });
    assert.ok(valid, 'Valid message must be intact');
  });

  test('Fuzz 2: Binary Control Characters and Null Bytes in Payloads', async () => {
    const binaryPayload = 'Header\x00NullByte\x01SOH\x02STX\x1bESC\x7fDEL\x1fUnitSep';

    const written = await writeMessage(fuzzAgent, {
      sender: 'binary-sender',
      recipient: fuzzAgent,
      body: binaryPayload
    });

    assert.ok(written && written.messageId);

    const inbox = await readInbox(fuzzAgent);
    assert.ok(inbox.length >= 1);
    const msg = inbox.find((m) => m.id === written.messageId || m.id === written.envelope?.id);
    assert.ok(msg);

    const receivedBody = msg.payload?.message || msg.payload?.body || msg.body;
    assert.equal(receivedBody, binaryPayload, 'Binary payload with null bytes must preserve round-trip byte fidelity');
  });

  test('Fuzz 3: Large Multi-Megabyte Payload (2MB string)', async () => {
    const sizeMb = 2;
    const largeChunk = 'ABCDEFGH12345678'.repeat(64 * 1024 * sizeMb); // ~2MB string

    const startWrite = Date.now();
    const written = await writeMessage(fuzzAgent, {
      sender: 'heavy-sender',
      recipient: fuzzAgent,
      body: largeChunk
    });
    const writeDuration = Date.now() - startWrite;

    assert.ok(written && written.messageId);
    assert.ok(writeDuration < 5000, `Writing 2MB payload took ${writeDuration}ms (< 5000ms threshold)`);

    const inbox = await readInbox(fuzzAgent);
    assert.ok(inbox.length >= 1);
    const msg = inbox.find((m) => m.id === written.messageId || m.id === written.envelope?.id);
    assert.ok(msg);

    const receivedBody = msg.payload?.message || msg.payload?.body || msg.body;
    assert.equal(receivedBody.length, largeChunk.length, 'Large payload length must match exactly without truncation');
  });

  test('Fuzz 4: Complex Multi-Byte Unicode, Emojis, ZWJ sequences, and RTL text', async () => {
    const complexUnicode = {
      emojis: '🚀🔥🎉✨💻🌍⚡️',
      zwjSequence: '👨‍👩‍👧‍👦 👩‍💻 🏳️‍🌈',
      rtlArabic: 'مرحبا بكم في نظام الرسائل الآمنة',
      rtlHebrew: 'שלום עולם מערכת הודעות',
      asianCJK: '你好世界 こんにちは世界 안녕하세요 세계',
      mathSymbols: '∑ ∏ ∫ ∬ ∭ ∮ ∇ ∆ ∂ ∀ ∃ ∄ ∅ ∈ ∉',
      surrogates: '𝕳𝖊𝖑𝖑𝖔 𝖂𝖔𝖗𝖑𝖉 𝟘𝟙𝟚𝟛'
    };

    const written = await writeMessage(fuzzAgent, {
      sender: 'unicode-sender',
      recipient: fuzzAgent,
      payload: complexUnicode
    });

    assert.ok(written);

    const inbox = await readInbox(fuzzAgent);
    const msg = inbox.find((m) => m.id === written.messageId || m.id === written.envelope?.id);
    assert.ok(msg);

    const receivedPayload = msg.payload;
    assert.deepEqual(receivedPayload, complexUnicode, 'Complex Unicode object must survive serialization with 100% fidelity');
  });

  test('Fuzz 5: Deeply Nested and Exotic Types in Envelope Payloads', async () => {
    let nested = { leaf: 'deepest value', count: 42, enabled: true, tags: ['a', 'b', null] };
    for (let d = 0; d < 15; d++) {
      nested = { depth: d, child: nested };
    }

    const written = await writeMessage(fuzzAgent, {
      sender: 'nested-sender',
      recipient: fuzzAgent,
      payload: nested
    });

    assert.ok(written);

    const inbox = await readInbox(fuzzAgent);
    const msg = inbox.find((m) => m.id === written.messageId || m.id === written.envelope?.id);
    assert.ok(msg);

    const receivedPayload = msg.payload;
    assert.deepEqual(receivedPayload, nested, 'Deeply nested object must round-trip cleanly without depth truncation');
  });
});
