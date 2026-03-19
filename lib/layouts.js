/**
 * layouts.js
 *
 * Defines the three built-in layout templates for gemini-hud.
 *
 * A layout is a function:
 *   (metrics, systemInfo, theme, width) => string[]
 *
 * It receives:
 *   metrics    — SessionMetrics from session-parser.js (or null)
 *   systemInfo — { gitBranch: string|null, cpuPercent: number }
 *   theme      — resolved Theme object from themes.js
 *   width      — usable inner width of the panel (terminal columns minus borders)
 *
 * It returns an array of plain (but ANSI-coloured) strings — one per panel row,
 * WITHOUT the box border characters. The renderer wraps them in the border.
 *
 * Built-in layouts:
 *   minimal  — 2 rows: status + tokens
 *   default  — 5 rows: full info (current behaviour)
 *   dev      — 7 rows: everything including git, CPU, raw model list
 */

import { formatTokens, formatDuration } from './session-parser.js';
import { ANSI } from './themes.js';

const RESET = ANSI.reset;

// ── helpers ───────────────────────────────────────────────────────────────────

/** Pad / truncate a string to exactly `len` characters (visual, ignores ANSI). */
function fitTo(str, len, padChar = ' ') {
  const plain = stripAnsi(str);
  if (plain.length > len) {
    // Truncate: need to work with the raw string up to the visual limit
    return truncateVisual(str, len);
  }
  return str + padChar.repeat(len - plain.length);
}

function truncateVisual(str, maxLen) {
  let visible = 0;
  let result = '';
  let inEsc = false;
  for (const ch of str) {
    if (ch === '\x1b') { inEsc = true; result += ch; continue; }
    if (inEsc) { result += ch; if (ch === 'm') inEsc = false; continue; }
    if (visible >= maxLen) break;
    result += ch;
    visible++;
  }
  return result + RESET;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Short tool name: "write_file" → "write", max 8 chars. */
function shortTool(name) {
  const clean = name.replace(/_file$|_tool$|_command$/i, '');
  return clean.length > 8 ? clean.slice(0, 7) + '…' : clean;
}

function statusDot(status, theme) {
  if (status === 'processing') return theme.processing + '● Processing' + RESET;
  if (status === 'idle')       return theme.idle       + '● Idle'       + RESET;
  return theme.dim + '○ Unknown' + RESET;
}

function cpuBar(percent) {
  const filled = Math.round(percent / 10); // 0-10 blocks
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `[${bar}] ${percent}%`;
}

// ── Layout: minimal ──────────────────────────────────────────────────────────
/**
 * minimal  — 2 content rows
 *
 * Row 1: Project · Branch · Status
 * Row 2: Model · Tokens total
 */
function layoutMinimal(metrics, sys, theme, width) {
  const T = theme;

  if (!metrics) {
    return [
      fitTo(T.dim + 'Waiting for Gemini CLI session…' + RESET, width),
      fitTo('', width),
    ];
  }

  const { sessionId, model, tokens, status } = metrics;
  const branch = sys.gitBranch ? `  ${T.accent}⎇ ${sys.gitBranch}${RESET}` : '';
  const proj   = T.value + (sessionId?.slice(0, 12) ?? '—') + RESET;

  const row1 = `${T.label}Session:${RESET} ${proj}${branch}  ${statusDot(status, T)}`;
  const row2 = `${T.label}Model:${RESET} ${T.value}${model || '—'}${RESET}  `
             + `${T.label}Tokens:${RESET} ${T.accent}${formatTokens(tokens.total)}${RESET} total`;

  return [fitTo(row1, width), fitTo(row2, width)];
}

// ── Layout: default ──────────────────────────────────────────────────────────
/**
 * default  — 5 content rows (original gemini-hud layout)
 *
 * Row 1: Project · Session duration · Git branch
 * Row 2: Messages · Turns · Status
 * Row 3: Model
 * Row 4: Tokens breakdown
 * Row 5: Top tools | Last user message
 */
function layoutDefault(metrics, sys, theme, width) {
  const T = theme;

  if (!metrics) {
    return [
      fitTo(T.dim + 'Waiting for Gemini CLI session…' + RESET, width),
      fitTo('', width),
      fitTo('', width),
      fitTo('', width),
      fitTo('', width),
    ];
  }

  const { durationMs, messageCount, turnCount, model, tokens, tools, lastUserMessage, status } = metrics;

  // Row 1 — project / duration / branch
  const dur    = T.value + formatDuration(durationMs) + RESET;
  const branch = sys.gitBranch
    ? `  ${T.accent}⎇ ${sys.gitBranch}${RESET}`
    : '';
  const row1 = `${T.label}Session:${RESET} ${dur}${branch}`;

  // Row 2 — message stats + status
  const row2 = `${T.label}Messages:${RESET} ${T.value}${messageCount}${RESET}`
             + `  ${T.label}Turns:${RESET} ${T.value}${turnCount}${RESET}`
             + `  ${statusDot(status, T)}`;

  // Row 3 — model
  const row3 = `${T.label}Model:${RESET} ${T.value}${model || '—'}${RESET}`;

  // Row 4 — tokens
  const tok = tokens;
  const row4 = `${T.label}Tokens:${RESET} ${T.accent}${formatTokens(tok.total)}${RESET} total`
             + `  (${T.dim}↓${formatTokens(tok.input)} in`
             + ` / ↑${formatTokens(tok.output)} out`
             + (tok.cached  ? ` / ◎${formatTokens(tok.cached)}`  : '')
             + (tok.thoughts? ` / ⚡${formatTokens(tok.thoughts)}`: '')
             + `${RESET})`;

  // Row 5 — top 3 tools + last message
  let row5;
  if (tools && tools.size > 0) {
    const topTools = [...tools.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => `${T.value}${shortTool(name)}${RESET}${T.dim}×${count}${RESET}`)
      .join('  ');
    row5 = `${T.label}Tools:${RESET} ${topTools}`;
  } else if (lastUserMessage) {
    const snippet = lastUserMessage.slice(0, width - 8);
    row5 = `${T.label}Last:${RESET} ${T.dim}"${snippet}"${RESET}`;
  } else {
    row5 = '';
  }

  return [row1, row2, row3, row4, row5].map(r => fitTo(r, width));
}

// ── Layout: dev ───────────────────────────────────────────────────────────────
/**
 * dev  — 8 content rows (everything, including history)
 *
 * Row 1: Session ID · duration
 * Row 2: Messages · Turns · Status
 * Row 3: Model(s) list
 * Row 4: Tokens: total (in / out / cached / thoughts)
 * Row 5: All tools with counts
 * Row 6: Git branch · CPU bar
 * Row 7: Last user message
 * Row 8: History totals (cross-session) — only if historyStats available
 */
function layoutDev(metrics, sys, theme, width) {
  const T = theme;

  if (!metrics) {
    return Array(8).fill(fitTo(T.dim + 'Waiting for Gemini CLI session…' + RESET, width));
  }

  const { sessionId, durationMs, messageCount, turnCount, model, models, tokens, tools, lastUserMessage, status } = metrics;
  const history = sys.historyStats;

  const row1 = `${T.label}Session:${RESET} ${T.dim}${sessionId ?? '—'}${RESET}`
             + `  ${T.label}Duration:${RESET} ${T.value}${formatDuration(durationMs)}${RESET}`;

  const row2 = `${T.label}Messages:${RESET} ${T.value}${messageCount}${RESET}`
             + `  ${T.label}Turns:${RESET} ${T.value}${turnCount}${RESET}`
             + `  ${statusDot(status, T)}`;

  const modelList = models && models.size > 1
    ? [...models].join(', ')
    : (model || '—');
  const row3 = `${T.label}Model:${RESET} ${T.value}${modelList}${RESET}`;

  const tok  = tokens;
  const row4 = `${T.label}Tokens:${RESET} ${T.accent}${formatTokens(tok.total)}${RESET}`
             + `  ↓${T.value}${formatTokens(tok.input)}${RESET}`
             + ` ↑${T.value}${formatTokens(tok.output)}${RESET}`
             + (tok.cached   ? `  ◎${T.dim}${formatTokens(tok.cached)}${RESET}`   : '')
             + (tok.thoughts ? `  ⚡${T.dim}${formatTokens(tok.thoughts)}${RESET}` : '');

  let row5;
  if (tools && tools.size > 0) {
    const all = [...tools.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${shortTool(name)}×${count}`)
      .join('  ');
    row5 = `${T.label}Tools:${RESET} ${T.value}${all}${RESET}`;
  } else {
    row5 = `${T.label}Tools:${RESET} ${T.dim}none${RESET}`;
  }

  const branchStr = sys.gitBranch ? `${T.accent}⎇ ${sys.gitBranch}${RESET}` : `${T.dim}—${RESET}`;
  const cpuStr    = `${T.label}CPU:${RESET} ${T.value}${cpuBar(sys.cpuPercent)}${RESET}`;
  const row6      = `${T.label}Git:${RESET} ${branchStr}  ${cpuStr}`;

  const snippet = lastUserMessage ? `"${lastUserMessage.slice(0, width - 10)}"` : '—';
  const row7    = `${T.label}Last:${RESET} ${T.dim}${snippet}${RESET}`;

  // Row 8 — cross-session history totals
  let row8;
  if (history) {
    row8 = `${T.dim}History:${RESET}`
         + `  ${T.label}sessions:${RESET} ${T.value}${history.totalSessions}${RESET}`
         + `  ${T.label}total tokens:${RESET} ${T.accent}${formatTokens(history.totalTokens)}${RESET}`
         + `  ${T.label}turns:${RESET} ${T.value}${history.totalTurns}${RESET}`;
  } else {
    row8 = `${T.dim}History: loading…${RESET}`;
  }

  return [row1, row2, row3, row4, row5, row6, row7, row8].map(r => fitTo(r, width));
}

// ── Public API ────────────────────────────────────────────────────────────────

export const LAYOUT_NAMES = ['minimal', 'default', 'dev'];

/** Number of content rows (excluding top/bottom border) for each layout. */
export const LAYOUT_HEIGHTS = { minimal: 2, default: 5, dev: 8 };

/**
 * Render content rows for the given layout.
 *
 * @param {string} layoutName
 * @param {import('./session-parser.js').SessionMetrics|null} metrics
 * @param {{ gitBranch: string|null, cpuPercent: number, historyStats: object|null }} systemInfo
 * @param {import('./themes.js').Theme} theme
 * @param {number} width  - usable inner width
 * @returns {string[]}
 */
export function renderLayout(layoutName, metrics, systemInfo, theme, width) {
  switch (layoutName) {
    case 'minimal': return layoutMinimal(metrics, systemInfo, theme, width);
    case 'dev':     return layoutDev(metrics, systemInfo, theme, width);
    default:        return layoutDefault(metrics, systemInfo, theme, width);
  }
}
