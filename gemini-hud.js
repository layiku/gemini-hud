#!/usr/bin/env node
/**
 * gemini-hud.js  —  Terminal Companion Monitor for Gemini CLI
 *
 * Usage:
 *   node gemini-hud.js                         # auto-detect from CWD
 *   node gemini-hud.js --project <name>        # monitor a named project
 *   node gemini-hud.js --layout <name>         # minimal | default | dev
 *   node gemini-hud.js --theme <name>          # default | dark | minimal | ocean | rose
 *   node gemini-hud.js --notify                # ring bell when Gemini responds
 *   node gemini-hud.js --export <json|csv>     # export current metrics and exit
 *   node gemini-hud.js --version               # print version
 *   node gemini-hud.js --help
 *
 * Run this in a SEPARATE terminal pane alongside your active gemini session.
 * It reads ~/.gemini/tmp/<project>/chats/session-*.json — a file that
 * Gemini CLI writes automatically — and renders a real-time HUD panel.
 * No injection, no wrapping, no modifications to gemini-cli.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

import { detectActiveSession, getProjectDisplayName } from './lib/project-detector.js';
import { watchSession } from './lib/session-watcher.js';
import { parseSessionSync, formatDuration } from './lib/session-parser.js';
import { initRenderer, cleanupRenderer, render } from './lib/renderer.js';
import { startGitPolling, stopGitPolling, startCpuPolling, stopCpuPolling } from './lib/system-info.js';
import { readHistoryStats } from './lib/history-reader.js';
import { notify } from './lib/notifier.js';
import { exportMetrics } from './lib/exporter.js';

// ── Version guard ─────────────────────────────────────────────────────────────

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error('gemini-hud requires Node.js 18.0.0+. Current:', process.version);
  process.exit(1);
}

// ── Read package version ──────────────────────────────────────────────────────

const PKG_VERSION = (() => {
  try {
    // fileURLToPath handles Windows drive letters correctly (avoids leading slash)
    const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url));
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch { return '0.0.0'; }
})();

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

/** Check if a boolean flag is present */
const hasFlag = (flag) => args.includes(flag);

/** Parse a named flag value, e.g. --project foo => 'foo' */
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] || null : null;
};

if (hasFlag('--version') || hasFlag('-v')) {
  console.log(`gemini-hud v${PKG_VERSION}`);
  process.exit(0);
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
gemini-hud v${PKG_VERSION} — Terminal Companion Monitor for Gemini CLI

Usage:
  gemini-hud                              Auto-detect active session from CWD
  gemini-hud --project <name>            Monitor a specific project by name
  gemini-hud --layout  <name>            Layout: minimal | default | dev
  gemini-hud --theme   <name>            Theme: default | dark | minimal | ocean | rose
  gemini-hud --notify                    Ring bell when Gemini finishes a response
  gemini-hud --export  <json|csv>        Export current session metrics to file and exit
  gemini-hud --version                   Print version
  gemini-hud --help                      Show this help

Examples:
  gemini-hud --layout dev --theme ocean
  gemini-hud --layout minimal --theme dark --notify
  gemini-hud --export json

Run in a separate terminal pane alongside your gemini session.
No changes to gemini-cli required.
  `.trim());
  process.exit(0);
}

const projectArg = getArg('--project');
const layoutArg  = getArg('--layout');
const themeArg   = getArg('--theme');
const exportArg  = getArg('--export');   // 'json' | 'csv' | null
const notifyFlag = hasFlag('--notify');

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  hud: {
    layout: 'default',   // 'minimal' | 'default' | 'dev'
    theme: 'default',    // 'default' | 'dark' | 'minimal' | 'ocean' | 'rose'
    show: {
      model: true,
      tokens: true,
      tools: true,
      lastMessage: true,
      time: true,
      sessionDuration: true,
    },
    maxToolsShown: 5,
  },
  colors: {},            // per-key ANSI overrides (see themes.js)
  performance: {
    renderFps: 10,
    pollIntervalMs: 2000,
  },
  project: {
    name: null,
  },
};

const deepMerge = (target, source) => {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
};

const loadConfig = () => {
  let config = { ...DEFAULT_CONFIG };
  const tryLoad = (path) => {
    if (existsSync(path)) {
      try {
        config = deepMerge(config, JSON.parse(readFileSync(path, 'utf8')));
      } catch (e) {
        // Silently ignore malformed config files
      }
    }
  };
  tryLoad(join(homedir(), '.gemini-hudrc'));
  tryLoad(join(process.cwd(), '.gemini-hudrc'));
  return config;
};

const CONFIG = loadConfig();

// CLI flags override config file (highest priority)
const VALID_LAYOUTS = ['minimal', 'default', 'dev'];
const VALID_THEMES  = ['default', 'dark', 'minimal', 'ocean', 'rose'];

if (layoutArg) {
  if (!VALID_LAYOUTS.includes(layoutArg)) {
    console.error(`Unknown layout "${layoutArg}". Valid options: ${VALID_LAYOUTS.join(', ')}`);
    process.exit(1);
  }
  CONFIG.hud.layout = layoutArg;
}

if (themeArg) {
  if (!VALID_THEMES.includes(themeArg)) {
    console.error(`Unknown theme "${themeArg}". Valid options: ${VALID_THEMES.join(', ')}`);
    process.exit(1);
  }
  CONFIG.hud.theme = themeArg;
}

const VALID_EXPORTS = ['json', 'csv'];
if (exportArg && !VALID_EXPORTS.includes(exportArg)) {
  console.error(`Unknown export format "${exportArg}". Valid options: ${VALID_EXPORTS.join(', ')}`);
  process.exit(1);
}

const RENDER_INTERVAL_MS = Math.max(50, Math.round(1000 / (CONFIG.performance?.renderFps ?? 10)));
const POLL_INTERVAL_MS = CONFIG.performance?.pollIntervalMs ?? 2000;

// ── State ─────────────────────────────────────────────────────────────────────

let currentSessionFile = null;
let currentProjectName = '';
let currentMetrics = null;
let previousStatus = null;   // for change-detection in notifier
let watcher = null;
let rescanTimer = null;

// ── Session management ────────────────────────────────────────────────────────

/**
 * Called whenever the session file changes.
 * Re-parses the JSON and updates currentMetrics.
 * Also triggers notifications on status transitions.
 */
const onSessionUpdate = (_filePath, rawContent) => {
  const metrics = parseSessionSync(rawContent);
  if (!metrics) return;

  // Detect processing → idle transition (Gemini just finished responding)
  if (notifyFlag && previousStatus === 'processing' && metrics.status === 'idle') {
    notify('Gemini responded', currentProjectName || 'gemini-hud');
  }

  previousStatus  = metrics.status;
  currentMetrics  = metrics;
};

/**
 * Switch monitoring to a new session file.
 *
 * @param {string} sessionFile
 * @param {string} projectName
 */
const switchToSession = (sessionFile, projectName) => {
  if (sessionFile === currentSessionFile) return;
  currentSessionFile = sessionFile;
  currentProjectName = projectName;
  currentMetrics = null;

  if (watcher) {
    watcher.switchFile(sessionFile);
  } else {
    watcher = watchSession(sessionFile, onSessionUpdate, { pollIntervalMs: POLL_INTERVAL_MS });
  }
};

/**
 * Scan for the active session and (re)attach the watcher.
 * Called at startup and periodically when no session is found.
 */
const rescan = async () => {
  const result = await detectActiveSession({
    project: projectArg || CONFIG.project?.name || null,
    cwd: process.cwd(),
  });

  if (result) {
    switchToSession(result.sessionFile, result.projectName);
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
  }
};

// ── History stats (loaded once after session is detected) ─────────────────────

let historyStats = null;

const loadHistory = async () => {
  if (!currentProjectName) return;
  historyStats = await readHistoryStats(currentProjectName);
};

// ── Render loop ───────────────────────────────────────────────────────────────

const runRenderLoop = () => {
  const renderFrame = () => {
    render(currentMetrics, {
      projectName: currentProjectName,
      sessionFile: currentSessionFile,
      waiting: !currentSessionFile,
      config: CONFIG,
      historyStats,
    });
  };

  // Initial render
  renderFrame();

  // Periodic re-render (for live clocks, processing timers, etc.)
  return setInterval(renderFrame, RENDER_INTERVAL_MS);
};

// ── Cleanup ───────────────────────────────────────────────────────────────────

const cleanup = () => {
  if (watcher) watcher.stop();
  if (rescanTimer) clearInterval(rescanTimer);
  stopGitPolling();
  stopCpuPolling();
  cleanupRenderer();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ── Entry point ───────────────────────────────────────────────────────────────

const main = async () => {
  // ── Export mode: detect session, export, then exit ───────────────────────
  if (exportArg) {
    await rescan();
    if (!currentMetrics) {
      console.error('No active Gemini session found. Start gemini in this directory first.');
      process.exit(1);
    }
    const outPath = await exportMetrics(currentMetrics, exportArg, currentProjectName);
    console.log(`Exported to: ${outPath}`);
    process.exit(0);
  }

  initRenderer();

  // Start background system-info pollers
  startGitPolling(process.cwd());
  startCpuPolling();

  // Initial session detection
  await rescan();

  // If no session found, keep rescanning until one appears
  if (!currentSessionFile) {
    rescanTimer = setInterval(rescan, POLL_INTERVAL_MS);
  } else {
    // Load history once session is found
    loadHistory();

    // Periodically check for newer sessions
    rescanTimer = setInterval(async () => {
      const result = await detectActiveSession({
        project: projectArg || CONFIG.project?.name || null,
        cwd: process.cwd(),
      });
      if (result && result.sessionFile !== currentSessionFile) {
        switchToSession(result.sessionFile, result.projectName);
        loadHistory();
      }
    }, 10_000);
  }

  runRenderLoop();
};

main().catch((err) => {
  cleanupRenderer();
  console.error('Fatal error:', err.message);
  process.exit(1);
});
