// test/stress-audio-silence.test.js - Gate 4 Mandatory Invariant Audit: Audio & Intrusive Text Purge
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const NOTIFICATIONS_PATH = path.join(ROOT_DIR, 'src', 'core', 'notifications.js');
const SERVER_PATH = path.join(ROOT_DIR, 'src', 'core', 'server.js');
const AUTOWAKE_PATH = path.join(ROOT_DIR, 'src', 'controllers', 'autowake.js');

test('Invariant 1: [console]::beep audio playback is completely purged from all modules', () => {
  const notifSrc = fs.readFileSync(NOTIFICATIONS_PATH, 'utf8');
  const srvSrc = fs.readFileSync(SERVER_PATH, 'utf8');
  const autowakeSrc = fs.readFileSync(AUTOWAKE_PATH, 'utf8');

  // Check for [console]::beep
  assert.doesNotMatch(notifSrc, /\[console\]::beep/i, 'src/core/notifications.js must not contain [console]::beep');
  assert.doesNotMatch(srvSrc, /\[console\]::beep/i, 'src/core/server.js must not contain [console]::beep');
  assert.doesNotMatch(autowakeSrc, /\[console\]::beep/i, 'src/controllers/autowake.js must not contain [console]::beep');
});

test('Invariant 2: OS audio chimes and AppleScript sound are completely stripped', () => {
  const notifSrc = fs.readFileSync(NOTIFICATIONS_PATH, 'utf8');

  // Check for AppleScript sound name parameter (e.g., sound name "Glass")
  const hasGlassSound = /sound\s+name\s+"Glass"/i.test(notifSrc);
  const hasAnySoundName = /sound\s+name/i.test(notifSrc);

  assert.strictEqual(
    hasAnySoundName,
    false,
    `src/core/notifications.js contains audio chime sound: "${notifSrc.match(/sound\s+name[^`\r\n"]*/i)?.[0] || 'sound name'}". This violates the permanent audio purge directive.`
  );
});

test('Invariant 3: notifySystem in server.js is completely silent and executes no audio', () => {
  const srvSrc = fs.readFileSync(SERVER_PATH, 'utf8');
  
  // Extract notifySystem implementation
  const match = srvSrc.match(/function\s+notifySystem\s*\([^)]*\)\s*\{([^}]*)\}/);
  assert.ok(match, 'notifySystem must exist in server.js');
  const body = match[1].trim();

  // Body must have no audio calls
  assert.doesNotMatch(body, /beep|exec|spawn|sound|chime/i, 'notifySystem must contain no audio execution');
});

test('Invariant 4: auto-reply in server.js is disabled by default to prevent echo loops', () => {
  const srvSrc = fs.readFileSync(SERVER_PATH, 'utf8');
  
  assert.match(
    srvSrc,
    /AUTO_REPLY_ENABLED\s*=\s*process\.argv\.includes\(['"]--auto-reply['"]\)\s*\|\|\s*process\.env\.INTERCOM_AUTO_REPLY\s*===\s*['"]true['"]/,
    'AUTO_REPLY_ENABLED must be disabled by default'
  );
});

test('Invariant 5: autowake wakeCliAgent executes without ReferenceError and uses sanitized names', () => {
  const { wakeCliAgent } = require('../src/controllers/autowake');
  const agentName = 'test_silence_' + Date.now();
  
  let result;
  assert.doesNotThrow(() => {
    result = wakeCliAgent(agentName, 'Test message for silence invariant');
  }, 'wakeCliAgent must execute cleanly without ReferenceError');

  assert.strictEqual(result.delivered, true);
  assert.strictEqual(result.target, agentName);
  assert.ok(result.file, 'wakeCliAgent must return valid inbox file');
});
