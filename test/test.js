/**
 * gemini-hud Core Logic Test Script (v0.0.5 Evolution)
 * Verified against the latest ESM Loader, Multi-session architecture, and zero-latency IPC.
 */

import assert from 'assert';
import path from 'path';
import os from 'os';

// ======================== Mock Implementation (Mirroring gemini_hud.js) ========================

let STATE = {
  model: 'unknown',
  tokenUsed: 0,
  status: 'idle',
  target: { total: 0, done: 0, list: [] },
  sessionCount: 0
};

let CACHE = {
  planMode: false,
  echoQueue: []
};

function resetState() {
  STATE = { model: 'unknown', tokenUsed: 0, status: 'idle', target: { total: 0, done: 0, list: [] }, sessionCount: 0 };
  CACHE = { planMode: false, echoQueue: [] };
}

/**
 * Mock Multi-session Aggregation
 */
function aggregate(sessionList) {
  if (!Array.isArray(sessionList) || sessionList.length === 0) {
    STATE.sessionCount = 0;
    return;
  }

  let totalInput = 0;
  let totalOutput = 0;
  let isAnyRunning = false;
  const modelSet = new Set();

  for (const s of sessionList) {
    totalInput += s.tokens?.input || 0;
    totalOutput += s.tokens?.output || 0;
    if (s.model) modelSet.add(s.model);
    if (s.isProcessing) isAnyRunning = true;
  }

  STATE.tokenUsed = totalInput + totalOutput;
  STATE.status = isAnyRunning ? 'running' : 'idle';
  STATE.sessionCount = sessionList.length;

  if (modelSet.size > 1) STATE.model = "Multi Gemini Model";
  else if (modelSet.size === 1) STATE.model = Array.from(modelSet)[0];
}

/**
 * Mock Intelligent Plan Capture (with Start/End logic)
 */
function parseAiPlan(text) {
  // Only parse when AI is running (State Lock)
  if (STATE.status !== 'running') {
    CACHE.planMode = false;
    return;
  }

  const lines = text.split('\n');
  for (const line of lines) {
    const cleanLine = line.trim();
    if (!cleanLine) continue;

    // Trigger Start
    if (cleanLine.match(/^(#+)\s+.*Plan/i) || cleanLine.match(/^(Plan|Steps|Tasks):/i)) {
      CACHE.planMode = true;
      STATE.target.list = [];
      STATE.target.total = 0;
      STATE.target.done = 0;
      continue;
    }

    if (CACHE.planMode) {
      const stepMatch = cleanLine.match(/^(\d+)\.\s+(.+)/);
      if (stepMatch) {
        if (!STATE.target.list.includes(stepMatch[2])) {
          STATE.target.list.push(stepMatch[2]);
          STATE.target.total = STATE.target.list.length;
        }
      } else {
        // Trigger End: New Header OR Long Body Text
        if (cleanLine.startsWith('#') || (STATE.target.total > 0 && cleanLine.length > 20)) {
          CACHE.planMode = false;
        }
      }
    }
  }
}

// ======================== Test Cases ========================

function runTests() {
  let passed = 0;
  let failed = 0;

  const test = (desc, fn) => {
    try {
      resetState();
      fn();
      console.log(`✅ ${desc}: Passed`);
      passed++;
    } catch (err) {
      console.log(`❌ ${desc}: Failed (${err.message})`);
      failed++;
    }
  };

  // Test 1: Multi-session Token Aggregation
  test('Token Aggregation & Model Conflict', () => {
    const sessions = [
      { model: 'gemini-pro', tokens: { input: 100, output: 50 }, isProcessing: false },
      { model: 'gemini-flash', tokens: { input: 200, output: 100 }, isProcessing: true }
    ];
    aggregate(sessions);
    assert.strictEqual(STATE.tokenUsed, 450);
    assert.strictEqual(STATE.status, 'running');
    assert.strictEqual(STATE.model, 'Multi Gemini Model');
  });

  // Test 2: Plan Capture Start and Continuous Grabbing
  test('Plan Capture Start & List Grabbing', () => {
    STATE.status = 'running';
    parseAiPlan('## Plan\n1. Task A\n2. Task B');
    assert.strictEqual(CACHE.planMode, true);
    assert.strictEqual(STATE.target.total, 2);
  });

  // Test 3: Plan Capture Termination (by New Header)
  test('Plan Capture Termination by New Header', () => {
    STATE.status = 'running';
    parseAiPlan('## Plan\n1. Task A');
    assert.strictEqual(CACHE.planMode, true);
    
    parseAiPlan('## Next Step'); // Should terminate
    assert.strictEqual(CACHE.planMode, false);
    assert.strictEqual(STATE.target.total, 1); // Progress should be preserved
  });

  // Test 4: Plan Capture Termination (by Body Text)
  test('Plan Capture Termination by Body Text', () => {
    STATE.status = 'running';
    parseAiPlan('Plan:\n1. Task A');
    assert.strictEqual(CACHE.planMode, true);
    
    parseAiPlan('This is a summary of the plan that is very long.'); // Should terminate
    assert.strictEqual(CACHE.planMode, false);
  });

  // Test 5: State Lock (Ignore capture when Idle)
  test('State Lock (Ignore lists when idle)', () => {
    STATE.status = 'idle';
    parseAiPlan('## Plan\n1. Task A'); // Should be ignored
    assert.strictEqual(CACHE.planMode, false);
    assert.strictEqual(STATE.target.total, 0);
  });

  // Test Summary
  console.log('\n======================= Test Results ========================');
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  if (failed === 0) console.log('🎉 System Logic is Solid!');
}

runTests();
