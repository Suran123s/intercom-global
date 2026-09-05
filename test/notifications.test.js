const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('child_process');

function getNotificationsWithMockedExec(mockExec) {
  delete require.cache[require.resolve('../src/core/notifications')];
  childProcess.exec = mockExec;
  return require('../src/core/notifications');
}

test('showDesktopNotification executes correct command on win32', () => {
  const originalPlatform = process.platform;
  const originalExec = childProcess.exec;
  let execCalledWith = null;
  let execOptions = null;

  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { showDesktopNotification } = getNotificationsWithMockedExec((cmd, opts, cb) => {
      execCalledWith = cmd;
      execOptions = opts;
      if (typeof opts === 'function') opts(null, '', '');
      else if (typeof cb === 'function') cb(null, '', '');
    });

    showDesktopNotification('Alert "Title"', 'Message "Text"');

    assert.ok(execCalledWith, 'exec should have been called');
    assert.ok(execCalledWith.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -Command '));
    assert.ok(execCalledWith.includes('Alert `"Title`"'));
    assert.ok(execCalledWith.includes('Message `"Text`"'));
    assert.deepStrictEqual(execOptions, { windowsHide: true });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    childProcess.exec = originalExec;
    delete require.cache[require.resolve('../src/core/notifications')];
  }
});

test('showDesktopNotification executes correct command on darwin', () => {
  const originalPlatform = process.platform;
  const originalExec = childProcess.exec;
  let execCalledWith = null;

  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { showDesktopNotification } = getNotificationsWithMockedExec((cmd, cb) => {
      execCalledWith = cmd;
      if (typeof cb === 'function') cb(null, '', '');
    });

    showDesktopNotification('Mac Title', 'Mac Message');

    assert.ok(execCalledWith, 'exec should have been called');
    assert.strictEqual(
      execCalledWith,
      `osascript -e 'display notification "Mac Message" with title "Mac Title" sound name "Glass"'`
    );
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    childProcess.exec = originalExec;
    delete require.cache[require.resolve('../src/core/notifications')];
  }
});

test('showDesktopNotification executes correct command on linux', () => {
  const originalPlatform = process.platform;
  const originalExec = childProcess.exec;
  let execCalledWith = null;

  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { showDesktopNotification } = getNotificationsWithMockedExec((cmd, cb) => {
      execCalledWith = cmd;
      if (typeof cb === 'function') cb(null, '', '');
    });

    showDesktopNotification('Linux Title', 'Linux Message');

    assert.ok(execCalledWith, 'exec should have been called');
    assert.strictEqual(
      execCalledWith,
      'notify-send "Linux Title" "Linux Message"'
    );
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    childProcess.exec = originalExec;
    delete require.cache[require.resolve('../src/core/notifications')];
  }
});

test('showDesktopNotification uses default values when title or message are missing', () => {
  const originalPlatform = process.platform;
  const originalExec = childProcess.exec;
  let execCalledWith = null;

  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { showDesktopNotification } = getNotificationsWithMockedExec((cmd, cb) => {
      execCalledWith = cmd;
      if (typeof cb === 'function') cb(null, '', '');
    });

    showDesktopNotification(null, undefined);

    assert.strictEqual(
      execCalledWith,
      'notify-send "Intercom Global" ""'
    );
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    childProcess.exec = originalExec;
    delete require.cache[require.resolve('../src/core/notifications')];
  }
});
