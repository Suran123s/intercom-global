const test = require('node:test');
const assert = require('assert');
const child_process = require('child_process');

test('showDesktopNotification uses execFile securely across platforms', (t) => {
  const originalPlatform = process.platform;
  let execFileArgs = [];

  // Mock child_process.execFile BEFORE importing module
  const originalExecFile = child_process.execFile;
  child_process.execFile = (file, args, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    execFileArgs.push({ file, args, options });
    if (callback) callback(null, '', '');
  };

  const { showDesktopNotification } = require('../src/core/notifications');

  t.after(() => {
    child_process.execFile = originalExecFile;
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true });
  });

  const testTitle = 'Title $(id) "quote" & ;';
  const testMessage = 'Message `whoami` $(whoami) "quote" \'single\' & ;';

  // 1. Test Linux platform
  Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
  execFileArgs = [];
  showDesktopNotification(testTitle, testMessage);
  assert.strictEqual(execFileArgs.length, 1);
  assert.strictEqual(execFileArgs[0].file, 'notify-send');
  assert.deepStrictEqual(execFileArgs[0].args, [testTitle, testMessage]);

  // 2. Test macOS (darwin) platform
  Object.defineProperty(process, 'platform', { value: 'darwin', writable: true, configurable: true });
  execFileArgs = [];
  showDesktopNotification(testTitle, testMessage);
  assert.strictEqual(execFileArgs.length, 1);
  assert.strictEqual(execFileArgs[0].file, 'osascript');
  assert.strictEqual(execFileArgs[0].args[0], '-e');
  assert.ok(execFileArgs[0].args[1].includes('Title $(id) \\"quote\\" & ;'));
  assert.ok(execFileArgs[0].args[1].includes('Message `whoami` $(whoami) \\"quote\\" \'single\' & ;'));

  // 3. Test Windows (win32) platform
  Object.defineProperty(process, 'platform', { value: 'win32', writable: true, configurable: true });
  execFileArgs = [];
  showDesktopNotification(testTitle, testMessage);
  assert.strictEqual(execFileArgs.length, 1);
  assert.strictEqual(execFileArgs[0].file, 'powershell');
  assert.deepStrictEqual(execFileArgs[0].args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.ok(execFileArgs[0].args[4].includes("''single''"));
});
