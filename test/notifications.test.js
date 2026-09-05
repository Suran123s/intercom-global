// test/notifications.test.js
const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('child_process');
const { showDesktopNotification } = require('../src/core/notifications');

test('showDesktopNotification executes execFile with env variables without string interpolation', (t) => {
  const originalExecFile = childProcess.execFile;
  let execFileCalled = false;
  let capturedFile = null;
  let capturedArgs = null;
  let capturedOptions = null;

  childProcess.execFile = (file, args, options, callback) => {
    execFileCalled = true;
    capturedFile = file;
    capturedArgs = args;
    capturedOptions = options;
    if (typeof callback === 'function') {
      callback(null, '', '');
    }
  };

  try {
    const maliciousTitle = '$(Start-Process calc.exe) " ; dir';
    const maliciousMsg = '$(Invoke-Expression "calc.exe") `whoami` " && echo hacked';

    showDesktopNotification(maliciousTitle, maliciousMsg);

    assert.strictEqual(execFileCalled, true, 'child_process.execFile should be called');

    if (process.platform === 'win32') {
      assert.strictEqual(capturedFile, 'powershell');
      assert.ok(capturedArgs.includes('-Command'));
      // Ensure the PowerShell script does NOT contain interpolated user strings
      const script = capturedArgs[capturedArgs.indexOf('-Command') + 1];
      assert.strictEqual(script.includes(maliciousTitle), false, 'Script should not contain raw title interpolation');
      assert.strictEqual(script.includes(maliciousMsg), false, 'Script should not contain raw message interpolation');
      assert.ok(script.includes('$env:NOTIFY_TITLE'), 'Script should reference $env:NOTIFY_TITLE');
      assert.ok(script.includes('$env:NOTIFY_MSG'), 'Script should reference $env:NOTIFY_MSG');

      // Verify environment variables contain the user strings
      assert.strictEqual(capturedOptions.env.NOTIFY_TITLE, maliciousTitle);
      assert.strictEqual(capturedOptions.env.NOTIFY_MSG, maliciousMsg);
    } else if (process.platform === 'darwin') {
      assert.strictEqual(capturedFile, 'osascript');
      const script = capturedArgs[capturedArgs.indexOf('-e') + 1];
      assert.strictEqual(script.includes(maliciousTitle), false, 'Script should not contain raw title interpolation');
      assert.strictEqual(script.includes(maliciousMsg), false, 'Script should not contain raw message interpolation');
      assert.ok(script.includes('system attribute "NOTIFY_TITLE"'));
      assert.ok(script.includes('system attribute "NOTIFY_MSG"'));

      assert.strictEqual(capturedOptions.env.NOTIFY_TITLE, maliciousTitle);
      assert.strictEqual(capturedOptions.env.NOTIFY_MSG, maliciousMsg);
    } else {
      assert.strictEqual(capturedFile, 'notify-send');
      assert.deepStrictEqual(capturedArgs, [maliciousTitle, maliciousMsg]);
    }
  } finally {
    childProcess.execFile = originalExecFile;
  }
});

test('showDesktopNotification uses default values when title or message are missing', (t) => {
  const originalExecFile = childProcess.execFile;
  let capturedOptions = null;
  let capturedArgs = null;

  childProcess.execFile = (file, args, options, callback) => {
    capturedArgs = args;
    capturedOptions = options;
    if (typeof callback === 'function') {
      callback(null, '', '');
    }
  };

  try {
    showDesktopNotification(null, null);

    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.strictEqual(capturedOptions.env.NOTIFY_TITLE, 'Intercom Global');
      assert.strictEqual(capturedOptions.env.NOTIFY_MSG, '');
    } else {
      assert.deepStrictEqual(capturedArgs, ['Intercom Global', '']);
    }
  } finally {
    childProcess.execFile = originalExecFile;
  }
});
