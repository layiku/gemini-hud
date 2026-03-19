/**
 * session-parser.js
 *
 * Parses Gemini CLI's native session JSON files and extracts normalized metrics.
 * Session files live at: ~/.gemini/tmp/<project>/chats/session-*.json
 *
 * The file is a single JSON object — not JSONL — so we parse the whole thing.
 * Benchmarked: ~29ms for a 3MB / 260-message session file. Acceptable for
 * re-parsing on every file-change event.
 */

import { readFile } from 'fs/promises';

// How long after the last user message before we consider status "unknown"
// instead of "processing" (10 minutes).
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @typedef {Object} TokenSummary
 * @property {number} input
 * @property {number} output
 * @property {number} cached
 * @property {number} thoughts
 * @property {number} total
 */

/**
 * @typedef {Object} SessionMetrics
 * @property {string} sessionId
 * @property {Date} sessionStart
 * @property {Date} lastUpdated
 * @property {number} durationMs
 * @property {number} messageCount   - all messages (user + gemini)
 * @property {number} turnCount      - gemini-type messages only
 * @property {string} model          - last model, or "Multi-model" if mixed
 * @property {Set<string>} models    - all models seen this session
 * @property {TokenSummary} tokens   - cumulative across all turns
 * @property {Map<string, number>} tools  - toolName -> call count
 * @property {string} lastUserMessage
 * @property {string} lastGeminiMessage
 * @property {'idle'|'processing'|'unknown'} status
 * @property {number} processingForMs  - ms since last user message
 */

/**
 * Parse a Gemini CLI session JSON file and return normalized metrics.
 *
 * @param {string} filePath - Absolute path to the session JSON file.
 * @returns {Promise<SessionMetrics|null>} Parsed metrics, or null on failure.
 */
export async function parseSession(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  return extractMetrics(data);
}

/**
 * Synchronous version for use in tight render loops.
 * Accepts a pre-read string to avoid double I/O.
 *
 * @param {string} jsonString - Raw JSON content.
 * @returns {SessionMetrics|null}
 */
export function parseSessionSync(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    return null;
  }
  return extractMetrics(data);
}

/**
 * Core extraction logic.
 *
 * @param {Object} data - Parsed session JSON object.
 * @returns {SessionMetrics|null}
 */
function extractMetrics(data) {
  if (!data || !Array.isArray(data.messages)) return null;

  const sessionStart = data.startTime ? new Date(data.startTime) : new Date();
  const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : new Date();
  const now = Date.now();

  // Cumulative token tallies
  const tokens = { input: 0, output: 0, cached: 0, thoughts: 0, total: 0 };

  // Track all models seen
  const models = new Set();

  // Tool call counts: name -> count
  const tools = new Map();

  let turnCount = 0;
  let lastUserMessage = '';
  let lastGeminiMessage = '';
  let lastUserTimestamp = null;
  let lastMessageType = 'unknown';

  for (const msg of data.messages) {
    if (!msg || !msg.type) continue;

    if (msg.type === 'user') {
      lastMessageType = 'user';
      lastUserTimestamp = msg.timestamp ? new Date(msg.timestamp) : null;
      // Content can be an array of {text} objects or a plain string
      lastUserMessage = extractTextContent(msg.content);

    } else if (msg.type === 'gemini') {
      lastMessageType = 'gemini';
      turnCount++;

      // Accumulate tokens
      if (msg.tokens) {
        tokens.input += msg.tokens.input || 0;
        tokens.output += msg.tokens.output || 0;
        tokens.cached += msg.tokens.cached || 0;
        tokens.thoughts += msg.tokens.thoughts || 0;
        tokens.total += msg.tokens.total || 0;
      }

      // Record model
      if (msg.model) models.add(msg.model);

      // Count tool calls
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (tc && tc.name) {
            tools.set(tc.name, (tools.get(tc.name) || 0) + 1);
          }
        }
      }

      lastGeminiMessage = typeof msg.content === 'string'
        ? msg.content
        : extractTextContent(msg.content);
    }
  }

  // Determine status
  let status = 'unknown';
  let processingForMs = 0;

  if (lastMessageType === 'gemini') {
    status = 'idle';
  } else if (lastMessageType === 'user' && lastUserTimestamp) {
    const elapsed = now - lastUserTimestamp.getTime();
    if (elapsed < PROCESSING_TIMEOUT_MS) {
      status = 'processing';
      processingForMs = elapsed;
    } else {
      status = 'unknown';
    }
  }

  // Determine displayed model name
  let model = 'unknown';
  if (models.size === 1) {
    model = Array.from(models)[0];
  } else if (models.size > 1) {
    model = 'Multi-model';
  }

  return {
    sessionId: data.sessionId || '',
    sessionStart,
    lastUpdated,
    durationMs: now - sessionStart.getTime(),
    messageCount: data.messages.length,
    turnCount,
    model,
    models,
    tokens,
    tools,
    lastUserMessage: lastUserMessage.slice(0, 120),
    lastGeminiMessage: lastGeminiMessage.slice(0, 120),
    status,
    processingForMs,
  };
}

/**
 * Extract plain text from a message's content field.
 * Content can be: a string, an array of {text} objects, or something else.
 *
 * @param {*} content
 * @returns {string}
 */
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && typeof c.text === 'string')
      .map(c => c.text)
      .join(' ');
  }
  return '';
}

/**
 * Format a token count into a compact human-readable string.
 * e.g. 45231 -> "45.2k", 1200000 -> "1.2M"
 *
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 90061 -> "1h 30m", 65000 -> "1m 5s"
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
