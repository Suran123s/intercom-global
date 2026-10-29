// src/core/notifications.js - Cross-Platform OS Desktop Toast Notifications (Audio Purged)
const childProcess = require('child_process');

function sanitizeAppleScript(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function showDesktopNotification(title, message, options = {}) {
  // Silent by default; only execute if explicitly requested or testing
  const safeTitle = title || 'Intercom Global';
  const safeMessage = message || '';

  if (process.platform === 'win32') {
    // Windows PowerShell Toast / Balloon Notification — silent, NO beep
    const psScript = `
      [void] [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms");
      $notify = New-Object System.Windows.Forms.NotifyIcon;
      $notify.Icon = [System.Drawing.SystemIcons]::Information;
      $notify.Visible = $true;
      $notify.ShowBalloonTip(5000, $args[0], $args[1], [System.Windows.Forms.ToolTipIcon]::Info);
    `.trim().replace(/\r?\n/g, ' ');

    childProcess.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript, safeTitle, safeMessage], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    // macOS AppleScript Notification — silent (sound removed completely per user directive)
    const macScript = `display notification "${sanitizeAppleScript(safeMessage)}" with title "${sanitizeAppleScript(safeTitle)}"`;

    childProcess.execFile('osascript', ['-e', macScript], () => {});
  } else {
    // Linux notify-send
    childProcess.execFile('notify-send', [safeTitle, safeMessage], () => {});
  }
}

module.exports = { showDesktopNotification, sanitizeAppleScript };
