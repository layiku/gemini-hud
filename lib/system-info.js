/**
 * system-info.js
 *
 * Background polling modules for system-level data:
 *   - Git branch (via `git rev-parse`)
 *   - CPU usage (via Node.js `os.cpus()`)
 *
 * Both are sampled on a timer so they never block the render loop.
 */

import { exec } from 'child_process';
import { cpus } from 'os';

// ── Git branch ────────────────────────────────────────────────────────────────

let _gitBranch = null;
let _gitTimer = null;

/**
 * Start polling git branch in the background.
 *
 * @param {string} cwd - Directory to run `git` in.
 * @param {number} intervalMs - Poll interval (default 5000ms).
 */
export function startGitPolling(cwd, intervalMs = 5000) {
  const refresh = () => {
    exec('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 2000 }, (err, stdout) => {
      _gitBranch = err ? null : stdout.trim();
    });
  };
  refresh();
  _gitTimer = setInterval(refresh, intervalMs);
}

export function stopGitPolling() {
  if (_gitTimer) { clearInterval(_gitTimer); _gitTimer = null; }
}

/**
 * @returns {string|null} Current branch name, or null if not in a git repo.
 */
export function getGitBranch() {
  return _gitBranch;
}

// ── CPU usage ─────────────────────────────────────────────────────────────────

let _cpuPercent = 0;
let _cpuTimer = null;
let _lastCpuTick = null;

function sampleCpuTotals() {
  const c = cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  for (const cpu of c) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys  += cpu.times.sys;
    idle += cpu.times.idle;
    irq  += cpu.times.irq;
  }
  return { user, nice, sys, idle, irq };
}

/**
 * Start polling CPU usage in the background.
 *
 * @param {number} intervalMs - Poll interval (default 2000ms).
 */
export function startCpuPolling(intervalMs = 2000) {
  _lastCpuTick = sampleCpuTotals();

  const refresh = () => {
    const curr = sampleCpuTotals();
    const prev = _lastCpuTick;

    const totalDiff =
      (curr.user - prev.user) +
      (curr.nice - prev.nice) +
      (curr.sys  - prev.sys)  +
      (curr.idle - prev.idle) +
      (curr.irq  - prev.irq);
    const idleDiff = curr.idle - prev.idle;

    _cpuPercent = totalDiff > 0
      ? Math.min(100, Math.max(0, Math.round(100 * (totalDiff - idleDiff) / totalDiff)))
      : 0;

    _lastCpuTick = curr;
  };

  _cpuTimer = setInterval(refresh, intervalMs);
}

export function stopCpuPolling() {
  if (_cpuTimer) { clearInterval(_cpuTimer); _cpuTimer = null; }
}

/**
 * @returns {number} CPU usage percentage 0-100.
 */
export function getCpuPercent() {
  return _cpuPercent;
}
