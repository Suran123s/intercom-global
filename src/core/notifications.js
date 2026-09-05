// src/core/notifications.js - Cross-Platform OS Desktop Toast Notifications & Audio Alerts
const { execFile } = require('child_process');

function showDesktopNotification(title, message, options = {}) {
  const rawTitle = title || 'Intercom Global';
  const rawMessage = message || '';

  if (process.platform === 'win32') {
    // Windows PowerShell Toast / Balloon Notification
    const psTitle = rawTitle.replace(/'/g, "''");
    const psMessage = rawMessage.replace(/'/g, "''");

    const psScript = `
      [void] [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms");
      $notify = New-Object System.Windows.Forms.NotifyIcon;
      $notify.Icon = [System.Drawing.SystemIcons]::Information;
      $notify.Visible = $true;
      $notify.ShowBalloonTip(5000, '${psTitle}', '${psMessage}', [System.Windows.Forms.ToolTipIcon]::Info);
      [console]::beep(900, 180);
    `.trim().replace(/\r?\n/g, ' ');

    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    // macOS AppleScript Notification
    const safeTitle = rawTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeMessage = rawMessage.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const macScript = `display notification "${safeMessage}" with title "${safeTitle}" sound name "Glass"`;

    execFile('osascript', ['-e', macScript], () => {});
  } else {
    // Linux notify-send
    execFile('notify-send', [rawTitle, rawMessage], () => {});
  }
}

module.exports = { showDesktopNotification };
