// src/core/notifications.js - Cross-Platform OS Desktop Toast Notifications & Audio Alerts
const { exec } = require('child_process');

function showDesktopNotification(title, message, options = {}) {
  const cleanTitle = (title || 'Intercom Global').replace(/"/g, '`"');
  const cleanMessage = (message || '').replace(/"/g, '`"');

  if (process.platform === 'win32') {
    // Windows PowerShell Toast / Balloon Notification
    const psScript = `
      [void] [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms");
      $notify = New-Object System.Windows.Forms.NotifyIcon;
      $notify.Icon = [System.Drawing.SystemIcons]::Information;
      $notify.Visible = $true;
      $notify.ShowBalloonTip(5000, "${cleanTitle}", "${cleanMessage}", [System.Windows.Forms.ToolTipIcon]::Info);
      [console]::beep(900, 180);
    `.trim().replace(/\r?\n/g, ' ');

    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    // macOS AppleScript Notification
    const macScript = `display notification "${cleanMessage}" with title "${cleanTitle}" sound name "Glass"`;
    exec(`osascript -e '${macScript}'`, () => {});
  } else {
    // Linux notify-send
    exec(`notify-send "${cleanTitle}" "${cleanMessage}"`, () => {});
  }
}

module.exports = { showDesktopNotification };
