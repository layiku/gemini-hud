/**
 * history-reader.js
 *
 * Reads Gemini CLI's cross-session history data from:
 *   ~/.gemini/tmp/<project>/logs.json
 *
 * This file is a JSON array of all user messages across all sessions for
 * the project. We combine it with the individual session files to compute
 * cumulative stats: total tokens, total turns, total tool calls, etc.
 *
 * @typedef {Object} HistoryStats
 * @property {number} totalSessions       - number of session files found
 * @property {number} totalMessages       - total user messages ever (from logs.json)
 * @property {number} totalTokens         - sum of all turn tokens across all sessions
 * @property {number} totalTurns          - total gemini turns across all sessions
 * @property {Map<string, number>} tools  - cumulative tool call counts
 * @property {Date|null} firstSeen        - timestamp of first ever message
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const GEMINI_TMP = join(homedir(), '.gemini', 'tmp');

/**
 * Read and aggregate historical stats for a given project.
 *
 * @param {string} projectName
 * @returns {Promise<HistoryStats|null>}
 */
export async function readHistoryStats(projectName) {
  try {
    const projectDir = join(GEMINI_TMP, projectName);
    if (!existsSync(projectDir)) return null;

    // ── 1. logs.json: total user messages ────────────────────────────────
    let totalMessages = 0;
    let firstSeen = null;

    const logsPath = join(projectDir, 'logs.json');
    if (existsSync(logsPath)) {
      try {
        const logs = JSON.parse(readFileSync(logsPath, 'utf8'));
        if (Array.isArray(logs)) {
          totalMessages = logs.length;
          // Find the earliest timestamp
          for (const entry of logs) {
            const t = entry.timestamp ? new Date(entry.timestamp) : null;
            if (t && (!firstSeen || t < firstSeen)) firstSeen = t;
          }
        }
      } catch { /* corrupt logs.json — skip */ }
    }

    // ── 2. session files: cumulative tokens + tools ───────────────────────
    const chatsDir = join(projectDir, 'chats');
    if (!existsSync(chatsDir)) return null;

    const sessionFiles = readdirSync(chatsDir)
      .filter(f => f.startsWith('session-') && f.endsWith('.json'));

    let totalTokens = 0;
    let totalTurns  = 0;
    const tools     = new Map();

    for (const file of sessionFiles) {
      try {
        const raw  = readFileSync(join(chatsDir, file), 'utf8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data.messages)) continue;

        for (const msg of data.messages) {
          if (msg.type !== 'gemini') continue;
          totalTurns++;
          if (msg.tokens?.total) totalTokens += msg.tokens.total;
          if (Array.isArray(msg.toolCalls)) {
            for (const tc of msg.toolCalls) {
              if (tc.name) tools.set(tc.name, (tools.get(tc.name) ?? 0) + 1);
            }
          }
        }
      } catch { /* corrupt session file — skip */ }
    }

    return {
      totalSessions: sessionFiles.length,
      totalMessages,
      totalTokens,
      totalTurns,
      tools,
      firstSeen,
    };
  } catch {
    return null;
  }
}
