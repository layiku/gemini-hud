/**
 * gemini-hud Core Logic Test Script (v0.1.0)
 * Tests session-parser.js — the heart of the new file-watching architecture.
 *
 * Run: node test/test.js
 * No additional dependencies required (uses Node.js built-in assert).
 */

import assert from 'assert';
import { parseSessionSync, formatTokens, formatDuration } from '../lib/session-parser.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const now = new Date().toISOString();
const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();

/**
 * Build a minimal session JSON string for testing.
 */
function makeSession({ messages = [], startTime = now, lastUpdated = now } = {}) {
  return JSON.stringify({
    sessionId: 'test-session-id',
    projectHash: 'abc123',
    startTime,
    lastUpdated,
    kind: 'main',
    messages,
  });
}

function userMsg(text, timestamp = now) {
  return { id: 'u1', timestamp, type: 'user', content: [{ text }] };
}

function geminiMsg({ model = 'gemini-flash', tokens = {}, toolCalls = [], timestamp = now } = {}) {
  return {
    id: 'g1',
    timestamp,
    type: 'gemini',
    content: 'Some response',
    tokens: { input: 0, output: 0, cached: 0, thoughts: 0, total: 0, ...tokens },
    model,
    toolCalls,
  };
}

// ── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(desc, fn) {
  try {
    fn();
    console.log(`✅ ${desc}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${desc}: ${err.message}`);
    failed++;
  }
}

// ── Session parser tests ───────────────────────────────────────────────────

test('Returns null for invalid JSON', () => {
  assert.strictEqual(parseSessionSync('not json'), null);
});

test('Returns null for missing messages array', () => {
  assert.strictEqual(parseSessionSync('{"sessionId":"x"}'), null);
});

test('Parses empty session', () => {
  const m = parseSessionSync(makeSession());
  assert.ok(m);
  assert.strictEqual(m.messageCount, 0);
  assert.strictEqual(m.turnCount, 0);
  assert.strictEqual(m.model, 'unknown');
  assert.strictEqual(m.status, 'unknown');
  assert.strictEqual(m.tokens.total, 0);
});

test('Accumulates tokens across multiple turns', () => {
  const session = makeSession({
    messages: [
      userMsg('hello'),
      geminiMsg({ tokens: { input: 100, output: 20, cached: 0, thoughts: 5, total: 125 } }),
      userMsg('world'),
      geminiMsg({ tokens: { input: 200, output: 30, cached: 50, thoughts: 0, total: 280 } }),
    ],
  });
  const m = parseSessionSync(session);
  assert.strictEqual(m.tokens.input, 300);
  assert.strictEqual(m.tokens.output, 50);
  assert.strictEqual(m.tokens.cached, 50);
  assert.strictEqual(m.tokens.thoughts, 5);
  assert.strictEqual(m.tokens.total, 405);
  assert.strictEqual(m.turnCount, 2);
  assert.strictEqual(m.messageCount, 4);
});

test('Detects single model', () => {
  const session = makeSession({
    messages: [
      userMsg('hi'),
      geminiMsg({ model: 'gemini-3-flash-preview' }),
      userMsg('again'),
      geminiMsg({ model: 'gemini-3-flash-preview' }),
    ],
  });
  const m = parseSessionSync(session);
  assert.strictEqual(m.model, 'gemini-3-flash-preview');
  assert.strictEqual(m.models.size, 1);
});

test('Detects multiple models (Multi-model)', () => {
  const session = makeSession({
    messages: [
      userMsg('hi'),
      geminiMsg({ model: 'gemini-flash' }),
      userMsg('again'),
      geminiMsg({ model: 'gemini-pro' }),
    ],
  });
  const m = parseSessionSync(session);
  assert.strictEqual(m.model, 'Multi-model');
  assert.strictEqual(m.models.size, 2);
});

test('Status is idle when last message is gemini type', () => {
  const session = makeSession({
    messages: [
      userMsg('do something'),
      geminiMsg({ tokens: { total: 10, input: 10, output: 0, cached: 0, thoughts: 0 } }),
    ],
  });
  const m = parseSessionSync(session);
  assert.strictEqual(m.status, 'idle');
});

test('Status is processing when last message is user (recent)', () => {
  const session = makeSession({
    messages: [
      geminiMsg(),
      userMsg('do something now', fiveMinAgo),
    ],
  });
  const m = parseSessionSync(session);
  assert.strictEqual(m.status, 'processing');
  assert.ok(m.processingForMs > 0);
});

test('Status is unknown when last user message is stale (> 10 min)', () => {
  const session = makeSession({
    messages: [
      geminiMsg(),
      userMsg('do something old', elevenMinAgo),
    ],
  });
  const m = parseSessionSync(session);
  assert.strictEqual(m.status, 'unknown');
});

test('Counts tool calls correctly', () => {
  const session = makeSession({
    messages: [
      userMsg('read some files'),
      geminiMsg({
        toolCalls: [
          { id: 't1', name: 'read_file', args: {}, status: 'success', timestamp: now },
          { id: 't2', name: 'read_file', args: {}, status: 'success', timestamp: now },
          { id: 't3', name: 'write_file', args: {}, status: 'success', timestamp: now },
        ],
      }),
    ],
  });
  const m = parseSessionSync(session);
  assert.strictEqual(m.tools.get('read_file'), 2);
  assert.strictEqual(m.tools.get('write_file'), 1);
  assert.strictEqual(m.tools.size, 2);
});

test('Captures last user message text', () => {
  const session = makeSession({
    messages: [
      userMsg('first message'),
      geminiMsg(),
      userMsg('second message'),
    ],
  });
  const m = parseSessionSync(session);
  assert.strictEqual(m.lastUserMessage, 'second message');
});

test('Truncates very long last user message to 120 chars', () => {
  const longText = 'x'.repeat(200);
  const session = makeSession({ messages: [userMsg(longText)] });
  const m = parseSessionSync(session);
  assert.strictEqual(m.lastUserMessage.length, 120);
});

// ── formatTokens tests ─────────────────────────────────────────────────────

test('formatTokens: under 1k', () => {
  assert.strictEqual(formatTokens(500), '500');
});

test('formatTokens: thousands', () => {
  assert.strictEqual(formatTokens(45231), '45.2k');
});

test('formatTokens: millions', () => {
  assert.strictEqual(formatTokens(1_500_000), '1.5M');
});

// ── formatDuration tests ───────────────────────────────────────────────────

test('formatDuration: seconds only', () => {
  assert.strictEqual(formatDuration(45_000), '45s');
});

test('formatDuration: minutes and seconds', () => {
  assert.strictEqual(formatDuration(125_000), '2m 5s');
});

test('formatDuration: hours and minutes', () => {
  assert.strictEqual(formatDuration(3_661_000), '1h 1m');
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════ Test Results ═══════════════════════════');
console.log(`Total: ${passed + failed}  │  ✅ Passed: ${passed}  │  ❌ Failed: ${failed}`);
if (failed === 0) {
  console.log('🎉 All tests passed!');
} else {
  process.exit(1);
}
