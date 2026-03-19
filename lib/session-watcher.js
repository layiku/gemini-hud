/**
 * session-watcher.js
 *
 * Watches a Gemini CLI session JSON file for changes.
 *
 * Strategy:
 *   1. Primary:  fs.watch() for low-latency change detection.
 *   2. Fallback: setInterval polling if fs.watch fails (network drives,
 *                some WSL/Windows configurations).
 *
 * The watcher calls onUpdate(filePath) whenever the file content changes.
 * It re-reads the file's mtime to avoid spurious callbacks.
 */

import { watch, statSync } from 'fs';
import { stat, readFile } from 'fs/promises';

/**
 * Start watching a session file.
 *
 * @param {string} filePath - Absolute path to the session JSON file.
 * @param {Function} onUpdate - Called with (filePath, rawContent) on change.
 * @param {Object} opts
 * @param {number} opts.pollIntervalMs - Fallback poll interval (default 2000ms).
 * @returns {{ stop: Function }} - Call stop() to cease watching.
 */
export function watchSession(filePath, onUpdate, { pollIntervalMs = 2000 } = {}) {
  let stopped = false;
  let lastMtime = 0;
  let watcher = null;
  let pollTimer = null;

  // Try to get initial mtime
  try {
    lastMtime = statSync(filePath).mtimeMs;
  } catch {
    // File may not exist yet; that's fine
  }

  /**
   * Check if the file has changed and call onUpdate if so.
   */
  const checkAndNotify = async () => {
    if (stopped) return;
    try {
      const s = await stat(filePath);
      if (s.mtimeMs !== lastMtime) {
        lastMtime = s.mtimeMs;
        const content = await readFile(filePath, 'utf8');
        onUpdate(filePath, content);
      }
    } catch {
      // File temporarily unavailable (e.g. being written); ignore
    }
  };

  /**
   * Attempt to use fs.watch. Falls back to polling on any error.
   */
  const startWatching = () => {
    try {
      watcher = watch(filePath, (eventType) => {
        if (stopped) return;

        // 'rename' means the file was replaced atomically (common on Linux/macOS).
        // Re-attach the watcher since the inode changed.
        if (eventType === 'rename') {
          if (watcher) {
            try { watcher.close(); } catch { /* ignore */ }
            watcher = null;
          }
          // Give the OS a moment to settle, then re-attach
          setTimeout(() => {
            if (!stopped) {
              checkAndNotify();
              startWatching();
            }
          }, 50);
          return;
        }

        // 'change' event: check mtime and notify
        checkAndNotify();
      });

      watcher.on('error', () => {
        // fs.watch failed; fall through to polling
        if (watcher) {
          try { watcher.close(); } catch { /* ignore */ }
          watcher = null;
        }
        startPolling();
      });
    } catch {
      // fs.watch not available; fall back immediately
      startPolling();
    }
  };

  /**
   * Start interval-based polling as a fallback.
   */
  const startPolling = () => {
    if (pollTimer) return; // already polling
    pollTimer = setInterval(() => {
      if (stopped) {
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      checkAndNotify();
    }, pollIntervalMs);
  };

  // Kick off watching
  startWatching();

  // Also do an immediate read to populate state on startup
  checkAndNotify();

  return {
    /**
     * Stop watching and clean up resources.
     */
    stop() {
      stopped = true;
      if (watcher) {
        try { watcher.close(); } catch { /* ignore */ }
        watcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    /**
     * Switch to watching a different file (e.g. when a new session starts).
     *
     * @param {string} newFilePath
     */
    switchFile(newFilePath) {
      if (watcher) {
        try { watcher.close(); } catch { /* ignore */ }
        watcher = null;
      }
      filePath = newFilePath;
      lastMtime = 0;
      try {
        lastMtime = statSync(filePath).mtimeMs;
      } catch { /* ignore */ }

      startWatching();
      checkAndNotify();
    },
  };
}
