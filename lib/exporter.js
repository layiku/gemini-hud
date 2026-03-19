/**
 * exporter.js
 *
 * Exports the current SessionMetrics to a file on disk.
 *
 * Supported formats:
 *   json — pretty-printed JSON object
 *   csv  — single-header + single-data-row CSV (easy to append across sessions)
 *
 * Output filename: gemini-hud-export-<YYYYMMDD-HHmmss>.<ext>
 * Written to the current working directory.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { formatTokens, formatDuration } from './session-parser.js';

/**
 * Export metrics to a file.
 *
 * @param {import('./session-parser.js').SessionMetrics} metrics
 * @param {'json'|'csv'} format
 * @param {string} [projectName]
 * @returns {Promise<string>} Absolute path of the written file.
 */
export async function exportMetrics(metrics, format, projectName = '') {
  const ts      = timestamp();
  const outPath = join(process.cwd(), `gemini-hud-export-${ts}.${format}`);

  if (format === 'json') {
    writeFileSync(outPath, buildJson(metrics, projectName), 'utf8');
  } else {
    writeFileSync(outPath, buildCsv(metrics, projectName), 'utf8');
  }

  return outPath;
}

// ── Builders ──────────────────────────────────────────────────────────────────

function buildJson(m, projectName) {
  const data = {
    exportedAt:       new Date().toISOString(),
    project:          projectName || null,
    sessionId:        m.sessionId,
    sessionStart:     m.sessionStart?.toISOString() ?? null,
    lastUpdated:      m.lastUpdated?.toISOString() ?? null,
    durationMs:       m.durationMs,
    durationHuman:    formatDuration(m.durationMs),
    messageCount:     m.messageCount,
    turnCount:        m.turnCount,
    status:           m.status,
    model:            m.model,
    models:           m.models ? [...m.models] : [],
    tokens: {
      total:    m.tokens.total,
      input:    m.tokens.input,
      output:   m.tokens.output,
      cached:   m.tokens.cached,
      thoughts: m.tokens.thoughts,
    },
    tools: m.tools
      ? Object.fromEntries([...m.tools.entries()].sort((a, b) => b[1] - a[1]))
      : {},
    lastUserMessage:  m.lastUserMessage || null,
  };
  return JSON.stringify(data, null, 2);
}

function buildCsv(m, projectName) {
  const headers = [
    'exportedAt', 'project', 'sessionId', 'sessionStart', 'durationMs',
    'messageCount', 'turnCount', 'status', 'model',
    'tokensTotal', 'tokensInput', 'tokensOutput', 'tokensCached', 'tokensThoughts',
    'topTool', 'topToolCount',
  ];

  // Top tool by usage count
  let topTool = '', topToolCount = 0;
  if (m.tools && m.tools.size > 0) {
    const top = [...m.tools.entries()].sort((a, b) => b[1] - a[1])[0];
    topTool      = top[0];
    topToolCount = top[1];
  }

  const values = [
    new Date().toISOString(),
    projectName || '',
    m.sessionId || '',
    m.sessionStart?.toISOString() ?? '',
    m.durationMs,
    m.messageCount,
    m.turnCount,
    m.status,
    m.model || '',
    m.tokens.total,
    m.tokens.input,
    m.tokens.output,
    m.tokens.cached,
    m.tokens.thoughts,
    topTool,
    topToolCount,
  ];

  return headers.join(',') + '\n' + values.map(csvCell).join(',') + '\n';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap a CSV cell value in quotes if it contains commas, quotes, or newlines. */
function csvCell(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Format current date as YYYYMMDD-HHmmss */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
