// src/core/notifications.js - Cross-Platform OS Desktop Toast Notifications & Audio Alerts
const childProcess = require('child_process');

function sanitizeAppleScript(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function showDesktopNotification(title, message, options = {}) {
  const safeTitle = title || 'Intercom Global';
  const safeMessage = message || '';

  if (process.platform === 'win32') {
    // Windows PowerShell Toast / Balloon Notification
    const psScript = `
      [void] [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms");
      $notify = New-Object System.Windows.Forms.NotifyIcon;
      $notify.Icon = [System.Drawing.SystemIcons]::Information;
      $notify.Visible = $true;
      $notify.ShowBalloonTip(5000, $args[0], $args[1], [System.Windows.Forms.ToolTipIcon]::Info);
      [console]::beep(900, 180);
    `.trim().replace(/\r?\n/g, ' ');

    childProcess.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript, safeTitle, safeMessage], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    // macOS AppleScript Notification
    const macScript = `display notification "${sanitizeAppleScript(safeMessage)}" with title "${sanitizeAppleScript(safeTitle)}" sound name "Glass"`;
    childProcess.execFile('osascript', ['-e', macScript], () => {});
  } else {
    // Linux notify-send
    childProcess.execFile('notify-send', [safeTitle, safeMessage], () => {});
  }
}

module.exports = { showDesktopNotification, sanitizeAppleScript };
