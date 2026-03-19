/**
 * notifier.js
 *
 * Zero-dependency system notifications for gemini-hud.
 *
 * Behavior by platform:
 *   macOS   — `osascript` display notification (native Notification Center)
 *   Linux   — `notify-send` if available, else terminal bell
 *   Windows — PowerShell BurntToast if available, else terminal bell
 *
 * Always also rings the terminal bell (BEL \x07) as the universal fallback.
 */

import { exec } from 'child_process';

/**
 * Send a system notification and ring the terminal bell.
 *
 * @param {string} message  - Notification body text
 * @param {string} [title]  - Notification title (default: 'gemini-hud')
 */
export function notify(message, title = 'gemini-hud') {
  // Always ring the terminal bell
  process.stdout.write('\x07');

  const platform = process.platform;

  if (platform === 'darwin') {
    notifyMacOS(title, message);
  } else if (platform === 'linux') {
    notifyLinux(title, message);
  } else if (platform === 'win32') {
    notifyWindows(title, message);
  }
  // Other platforms: bell only (already done above)
}

// ── Platform-specific implementations ────────────────────────────────────────

function notifyMacOS(title, message) {
  // Escape single quotes for AppleScript
  const t = title.replace(/'/g, "\\'");
  const m = message.replace(/'/g, "\\'");
  exec(
    `osascript -e 'display notification "${m}" with title "${t}"'`,
    { timeout: 3000 },
    () => {} // ignore errors silently
  );
}

function notifyLinux(title, message) {
  // Try notify-send; falls back to bell (already sent)
  exec(
    `notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`,
    { timeout: 3000 },
    () => {}
  );
}

function notifyWindows(title, message) {
  // Try Windows Toast via PowerShell (works on Win 10+)
  // Falls back to just the bell (already sent)
  const ps = `
    $t = '${title.replace(/'/g, "''")}';
    $m = '${message.replace(/'/g, "''")}';
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
    $template.SelectSingleNode("//text[@id='1']").InnerText = $t;
    $template.SelectSingleNode("//text[@id='2']").InnerText = $m;
    $toast = [Windows.UI.Notifications.ToastNotification]::new($template);
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('gemini-hud').Show($toast);
  `.trim();
  exec(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { timeout: 5000 }, () => {});
}
