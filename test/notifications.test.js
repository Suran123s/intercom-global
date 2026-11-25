const test = require('node:test');
const assert = require('node:assert');
const child_process = require('child_process');
const { showDesktopNotification, sanitizeAppleScript } = require('../src/core/notifications');

test('sanitizeAppleScript escapes backslashes and double quotes correctly', () => {
  assert.strictEqual(sanitizeAppleScript('hello "world"'), 'hello \\"world\\"');
  assert.strictEqual(sanitizeAppleScript('C:\\Path\\To\\File'), 'C:\\\\Path\\\\To\\\\File');
  assert.strictEqual(sanitizeAppleScript('$(whoami); echo "pwn"'), '$(whoami); echo \\"pwn\\"');
});

test('showDesktopNotification invokes execFile with safe arguments on darwin (silent, no audio)', (t) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

  let calledFile = null;
  let calledArgs = null;

  const originalExecFile = child_process.execFile;
  child_process.execFile = (file, args, options, callback) => {
    calledFile = file;
    calledArgs = args;
    if (typeof options === 'function') options();
    if (typeof callback === 'function') callback();
  };

  try {
    const maliciousPayload = 'Test " ; touch /tmp/pwned ; echo "';
    showDesktopNotification('Alert "$(whoami)"', maliciousPayload);

    assert.strictEqual(calledFile, 'osascript');
    assert.strictEqual(calledArgs.length, 2);
    assert.strictEqual(calledArgs[0], '-e');
    assert.strictEqual(
      calledArgs[1],
      'display notification "Test \\" ; touch /tmp/pwned ; echo \\"" with title "Alert \\"$(whoami)\\""'
    );
  } finally {
    child_process.execFile = originalExecFile;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
});

test('showDesktopNotification invokes execFile with safe EncodedCommand, env vars, and Dispose() on win32', (t) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  let calledFile = null;
  let calledArgs = null;
  let calledOptions = null;

  const originalExecFile = child_process.execFile;
  child_process.execFile = (file, args, options, callback) => {
    calledFile = file;
    calledArgs = args;
    calledOptions = options;
    if (typeof options === 'function') options();
    if (typeof callback === 'function') callback();
  };

  try {
    showDesktopNotification('WinTitle', 'WinMessage; calc.exe');

    assert.strictEqual(calledFile, 'powershell');
    assert.deepStrictEqual(calledArgs.slice(0, 5), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ]);
    assert.strictEqual(calledArgs.length, 6);

    const decodedScript = Buffer.from(calledArgs[5], 'base64').toString('utf16le');
    assert.match(decodedScript, /\$env:INTERCOM_TITLE/);
    assert.match(decodedScript, /\$env:INTERCOM_MSG/);
    assert.match(decodedScript, /\$notify\.Dispose\(\)/);

    assert.strictEqual(calledOptions.windowsHide, true);
    assert.strictEqual(calledOptions.env.INTERCOM_TITLE, 'WinTitle');
    assert.strictEqual(calledOptions.env.INTERCOM_MSG, 'WinMessage; calc.exe');
  } finally {
    child_process.execFile = originalExecFile;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
});

test('showDesktopNotification invokes execFile with "--" option separator on linux', (t) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

  let calledFile = null;
  let calledArgs = null;

  const originalExecFile = child_process.execFile;
  child_process.execFile = (file, args, options, callback) => {
    calledFile = file;
    calledArgs = args;
    if (typeof options === 'function') options();
    if (typeof callback === 'function') callback();
  };

  try {
    showDesktopNotification('LinuxTitle', 'LinuxMessage; $(whoami)');

    assert.strictEqual(calledFile, 'notify-send');
    assert.strictEqual(calledArgs.length, 3);
    assert.strictEqual(calledArgs[0], '--');
    assert.strictEqual(calledArgs[1], 'LinuxTitle');
    assert.strictEqual(calledArgs[2], 'LinuxMessage; $(whoami)');
  } finally {
    child_process.execFile = originalExecFile;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
});
