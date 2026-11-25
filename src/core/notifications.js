// src/core/notifications.js - Cross-Platform OS Desktop Toast Notifications (Audio Purged)
const childProcess = require('child_process');

function sanitizeAppleScript(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function showDesktopNotification(title, message, options = {}) {
  // Silent by default; only execute if explicitly requested or testing
  const safeTitle = String(title || 'Intercom Global');
  const safeMessage = String(message || '');

  if (process.platform === 'win32') {
    // Windows PowerShell Toast / Balloon Notification — silent, NO beep, safe env var passing + Dispose()
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$notify = New-Object System.Windows.Forms.NotifyIcon;',
      'try {',
      '  $notify.Icon = [System.Drawing.SystemIcons]::Information;',
      '  $notify.Visible = $true;',
      '  $notify.ShowBalloonTip(5000, $env:INTERCOM_TITLE, $env:INTERCOM_MSG, [System.Windows.Forms.ToolTipIcon]::Info);',
      '  Start-Sleep -Milliseconds 100;',
      '} finally {',
      '  $notify.Visible = $false;',
      '  $notify.Dispose();',
      '}'
    ].join(' ');
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

    childProcess.execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env: {
          ...process.env,
          INTERCOM_TITLE: safeTitle,
          INTERCOM_MSG: safeMessage
        }
      },
      () => {}
    );
  } else if (process.platform === 'darwin') {
    // macOS AppleScript Notification — silent (sound removed completely per user directive)
    const macScript = `display notification "${sanitizeAppleScript(safeMessage)}" with title "${sanitizeAppleScript(safeTitle)}"`;

    childProcess.execFile('osascript', ['-e', macScript], () => {});
  } else {
    // Linux notify-send with '--' to prevent option injection
    childProcess.execFile('notify-send', ['--', safeTitle, safeMessage], () => {});
  }
}

module.exports = { showDesktopNotification, sanitizeAppleScript };
