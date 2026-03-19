/**
 * renderer.js
 *
 * ANSI terminal renderer for gemini-hud's split-pane display.
 *
 * Renders a fixed-height panel that refreshes in-place using cursor
 * repositioning — no flickering, no clearing the whole terminal.
 *
 * Delegates content rows to layouts.js (minimal / default / dev).
 * Colors are resolved via themes.js (default / dark / minimal / ocean / rose).
 *
 * Panel structure:
 * ┌─ gemini-hud ─────────────────────────── 14:32:05 ─┐
 * │ <layout rows…>                                      │
 * └─────────────────────────────────────────────────────┘
 */

import { resolveTheme } from './themes.js';
import { renderLayout } from './layouts.js';
import { getGitBranch, getCpuPercent } from './system-info.js';

// ── ANSI cursor helpers ──────────────────────────────────────────────────────

const ESC          = '\x1b[';
const RESET        = '\x1b[0m';
const BOLD         = '\x1b[1m';
const BLINK        = '\x1b[5m';
const ERASE_LINE   = `${ESC}2K`;
const CURSOR_UP    = (n) => `${ESC}${n}A`;
const CURSOR_COL   = (n) => `${ESC}${n}G`;
const HIDE_CURSOR  = '\x1b[?25l';
const SHOW_CURSOR  = '\x1b[?25h';

// ── Box drawing ──────────────────────────────────────────────────────────────

const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };

// ── Renderer state ───────────────────────────────────────────────────────────

let panelLines   = 0;     // how many lines we last printed (for cursor reposition)
let lastRendered = '';    // dirty-check: skip render if output unchanged
let isFirstRender = true;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the renderer. Call once at startup.
 */
export function initRenderer() {
  process.stdout.write(HIDE_CURSOR);
}

/**
 * Restore terminal state. Call on exit.
 */
export function cleanupRenderer() {
  if (panelLines > 0) {
    process.stdout.write(CURSOR_UP(panelLines));
    for (let i = 0; i < panelLines; i++) {
      process.stdout.write(ERASE_LINE + '\n');
    }
    process.stdout.write(CURSOR_UP(panelLines));
  }
  process.stdout.write(SHOW_CURSOR);
}

/**
 * Render (or re-render) the HUD panel with the given state.
 *
 * @param {import('./session-parser.js').SessionMetrics|null} metrics
 * @param {Object} opts
 * @param {string}      opts.projectName
 * @param {string|null} opts.sessionFile   - path being watched (for display)
 * @param {boolean}     opts.waiting       - true if no session found yet
 * @param {Object}      opts.config        - loaded .gemini-hudrc config
 * @param {object|null} opts.historyStats  - cross-session history from history-reader.js
 * @param {object|null} opts.performanceState - slow-parse/degraded-state indicator
 */
export function render(
  metrics,
  { projectName = '', sessionFile = null, waiting = false, config = {}, historyStats = null, performanceState = null } = {},
) {
  const cols   = Math.max(60, process.stdout.columns || 80);
  const layout = config?.hud?.layout ?? 'default';
  const theme  = resolveTheme(config?.hud?.theme ?? 'default', config?.colors ?? {});

  const lines  = buildPanel(metrics, {
    projectName, sessionFile, waiting, cols, layout, theme, config, historyStats, performanceState,
  });
  const output = lines.join('\n') + '\n';

  // Dirty check: skip if nothing changed
  if (output === lastRendered && !isFirstRender) return;
  lastRendered = output;

  // Move cursor back up to overwrite previous panel
  if (!isFirstRender && panelLines > 0) {
    process.stdout.write(CURSOR_UP(panelLines) + CURSOR_COL(1));
  }

  process.stdout.write(output);
  panelLines    = lines.length;
  isFirstRender = false;
}

// ── Panel builder ─────────────────────────────────────────────────────────────

function buildPanel(metrics, { projectName, sessionFile, waiting, cols, layout, theme, config, historyStats, performanceState }) {
  const innerWidth = cols - 4; // "│ " + " │"
  const T          = theme;
  const lines      = [];

  // ── Top border ──────────────────────────────────────────────────────────
  const show    = config?.hud?.show ?? {};
  const timeStr = show.time !== false
    ? ` ${new Date().toLocaleTimeString('en-GB', { hour12: false })} `
    : '';
  const layoutTag = ` [${layout}] `;
  const title     = ` gemini-hud `;
  const fillLen   = Math.max(0, innerWidth + 2 - title.length - timeStr.length - layoutTag.length);
  lines.push(
    T.border + BOX.tl + RESET +
    BOLD + T.accent + title + RESET +
    T.dim  + BOX.h.repeat(fillLen) + RESET +
    T.dim  + layoutTag + RESET +
    T.dim  + timeStr + RESET +
    T.border + BOX.tr + RESET
  );

  // ── Performance warning (degraded mode) ──────────────────────────────────
  if (performanceState?.degraded) {
    const shouldBlink = Math.floor(Date.now() / 500) % 2 === 0;
    const blinkPrefix = shouldBlink ? BLINK : '';
    const msg = `${blinkPrefix}${T.warn}WARNING:${RESET} `
      + `${T.warn}Session too large; parse ${performanceState.parseMs}ms `
      + `(>${performanceState.thresholdMs}ms). Data may be unreliable.${RESET}`;
    lines.push(wrapRow(msg, innerWidth, T));
  }

  // ── Waiting / no-session state ───────────────────────────────────────────
  if (waiting || !metrics) {
    const watchMsg = sessionFile
      ? `Watching: ${sessionFile}`
      : 'Scanning ~/.gemini/tmp/…';
    lines.push(wrapRow(T.warn + '  Waiting for Gemini CLI session…' + RESET, innerWidth, T));
    lines.push(wrapRow(T.dim  + `  ${watchMsg}` + RESET, innerWidth, T));
    lines.push(bottomBorder(cols, T));
    return lines;
  }

  // ── Content rows from layout ─────────────────────────────────────────────
  const sysInfo = {
    gitBranch:    getGitBranch(),
    cpuPercent:   getCpuPercent(),
    historyStats: historyStats ?? null,
  };

  const contentRows = renderLayout(layout, metrics, sysInfo, T, innerWidth);
  for (const contentRow of contentRows) {
    lines.push(wrapRow(contentRow, innerWidth, T));
  }

  // ── Bottom border ────────────────────────────────────────────────────────
  lines.push(bottomBorder(cols, T));

  return lines;
}

// ── Row helpers ───────────────────────────────────────────────────────────────

/**
 * Wrap a content string in border characters, padding to innerWidth.
 * ANSI codes are invisible, so we strip them to measure visual length.
 */
function wrapRow(content, innerWidth, theme) {
  const visLen  = stripAnsiLength(content);
  const padding = Math.max(0, innerWidth - visLen);
  return (
    theme.border + BOX.v + RESET +
    ' ' + content + ' '.repeat(padding) + ' ' +
    theme.border + BOX.v + RESET
  );
}

function bottomBorder(cols, theme) {
  return theme.border + BOX.bl + BOX.h.repeat(cols - 2) + BOX.br + RESET;
}

function stripAnsiLength(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}
