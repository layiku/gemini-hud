import * as pty from 'node-pty';
import ansiEscapes from 'ansi-escapes';
import stripAnsi from 'strip-ansi';
import { homedir, cpus, platform } from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';

// ====================== Configuration ======================
const LAYOUT_TEMPLATES = {
  default: ['time', 'model', 'tokens', 'status', 'target'],
  minimal: ['model', 'status'],
  full: ['time', 'cpu', 'model', 'tokens', 'mcp', 'git', 'path', 'status', 'target'],
  dev: ['time', 'cpu', 'git', 'path', 'model', 'tokens', 'mcp', 'status', 'target'],
  clean: ['time', 'tokens', 'status', 'target'],
  custom: []
};

const DEFAULT_CONFIG = {
  hud: {
    rows: 1,
    colors: { idle: '\x1b[32m', running: '\x1b[34m', error: '\x1b[31m' },
    show: {
      model: true,
      tokens: true,
      mcp: true,
      target: true,
      gitBranch: true,
      currentFilePath: true,
      time: true,
      cpuUsage: true
    },
    progressBar: { full: '█', empty: '░', length: 30 },
    pathStyle: 'short',
    layout: {
      template: 'default',
      customOrder: []
    }
  },
  performance: {
    resizeDebounceMs: 50,
    resizeThreshold: 2,
    renderFps: 30,
    gitUpdateIntervalMs: 5000
  },
  gemini: { command: 'gemini', autoRestart: true, restartDelayMs: 5000 },
  paths: {
    state: join(homedir(), '.gemini-hud-state.json'),
    target: join(homedir(), '.gemini-hud-target.txt'),
    globalConfig: join(homedir(), '.gemini-hudrc'),
    projectConfig: join(process.cwd(), '.gemini-hudrc')
  }
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
  let merged = { ...DEFAULT_CONFIG };
  const tryLoad = (path) => {
    if (existsSync(path)) {
      try {
        const fileContent = readFileSync(path, 'utf8');
        merged = deepMerge(merged, JSON.parse(fileContent));
      } catch (e) {
        console.warn(`⚠️ Failed to load config: ${path}`, e.message);
      }
    }
  };
  tryLoad(DEFAULT_CONFIG.paths.globalConfig);
  tryLoad(DEFAULT_CONFIG.paths.projectConfig);
  return merged;
};

const CONFIG = loadConfig();

// ====================== Cache ======================
const CACHE = {
  term: { cols: 0, rows: 0 },
  pty: { cols: 0, rows: 0 },
  lastHud: '',
  isResizing: false,
  echoQueue: [], 
  planMode: false,
  lastPlanTime: 0
};

// ====================== State ======================
const STATE = {
  model: 'gemini-1.5-flash',
  tokenUsed: 0,
  tokenMax: 128000,
  activeTool: null,
  mcpCount: 0,
  status: 'idle',
  target: { text: 'No target', total: 0, done: 0, percent: 0, list: [] },
  gitBranch: 'no git',
  currentFilePath: '~',
  time: '00:00:00',
  cpuPercent: 0,
  sessionCount: 0
};

// ====================== Modules ======================
const updateSystemTime = () => {
  const now = new Date();
  STATE.time = now.toLocaleTimeString('en-GB', { hour12: false });
};

let lastCpuTick = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
const updateCpuUsage = () => {
  const cpusInfo = cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  cpusInfo.forEach(c => {
    user += c.times.user; nice += c.times.nice; sys += c.times.sys; idle += c.times.idle; irq += c.times.irq;
  });
  const total = user + nice + sys + idle + irq;
  const lastTotal = lastCpuTick.user + lastCpuTick.nice + lastCpuTick.sys + lastCpuTick.idle + lastCpuTick.irq;
  const totalDiff = total - lastTotal;
  const idleDiff = idle - lastCpuTick.idle;
  const usage = totalDiff > 0 ? Math.round(100 * (totalDiff - idleDiff) / totalDiff) : 0;
  STATE.cpuPercent = Math.min(100, Math.max(0, usage));
  lastCpuTick = { user, nice, sys, idle, irq };
};

const updateGitBranch = () => {
  exec('git rev-parse --abbrev-ref HEAD', (err, stdout) => {
    STATE.gitBranch = err ? 'no git' : stdout.trim();
  });
};

const updateFilePath = () => {
  const cwd = process.cwd();
  STATE.currentFilePath = CONFIG.hud.pathStyle === 'short' ? cwd.replace(homedir(), '~') : cwd;
};

const syncStateFile = () => {
  const STATE_FILE = CONFIG.paths.state;
  if (!existsSync(STATE_FILE)) return;

  try {
    const rawContent = readFileSync(STATE_FILE, 'utf8');
    if (!rawContent.trim()) return;
    
    const sessionList = JSON.parse(rawContent);
    if (!Array.isArray(sessionList) || sessionList.length === 0) {
      STATE.sessionCount = 0;
      return;
    }

    let totalInput = 0;
    let totalOutput = 0;
    let isAnyRunning = false;
    let activeTool = null;
    const modelSet = new Set();

    for (const s of sessionList) {
      totalInput += s.tokens?.input || 0;
      totalOutput += s.tokens?.output || 0;
      if (s.model) modelSet.add(s.model);
      if (s.isProcessing) {
        isAnyRunning = true;
        activeTool = s.activeTool || activeTool;
      }
    }

    STATE.tokenUsed = totalInput + totalOutput;
    STATE.status = isAnyRunning ? 'running' : 'idle';
    STATE.activeTool = activeTool;
    STATE.sessionCount = sessionList.length;

    if (modelSet.size > 1) {
      STATE.model = "Multi Gemini Model";
    } else if (modelSet.size === 1) {
      STATE.model = Array.from(modelSet)[0];
    }
  } catch (e) { }
};

// ====================== Utils ======================
const debounce = (fn, delay) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

const throttle = (fn, limit) => {
  let lastCall = 0;
  return (...args) => {
    const now = Date.now();
    if (now - lastCall >= limit) {
      fn(...args);
      lastCall = now;
    }
  };
};

const getSafeTermSize = () => ({
  cols: Math.max(10, process.stdout.columns || 80),
  rows: Math.max(2, process.stdout.rows || 24)
});

// ====================== Terminal Control ======================
const setScrollRegion = () => {
  const endRow = CACHE.term.rows - CONFIG.hud.rows;
  process.stdout.write(`\x1b[1;${endRow}r`);
};

const resetScrollRegion = () => {
  process.stdout.write('\x1b[r');
  if (ansiEscapes.cursorShow) process.stdout.write(ansiEscapes.cursorShow);
};

// ====================== Parsing ======================

const parseAiPlan = (text) => {
  if (STATE.status !== 'running') {
    CACHE.planMode = false;
    return;
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const cleanLine = line.trim();
    if (!cleanLine) continue;

    if (cleanLine.match(/^(#+)\s+.*Plan/i) || cleanLine.match(/^(Plan|Steps|Tasks):/i)) {
      CACHE.planMode = true;
      CACHE.lastPlanTime = Date.now();
      STATE.target.list = [];
      STATE.target.total = 0;
      STATE.target.done = 0;
      continue;
    }

    if (CACHE.planMode) {
      const stepMatch = cleanLine.match(/^(\d+)\.\s+(.+)/);
      if (stepMatch) {
        const taskText = stepMatch[2];
        if (!STATE.target.list.includes(taskText)) {
          STATE.target.list.push(taskText);
          STATE.target.total = Math.max(STATE.target.total, STATE.target.list.length);
          CACHE.lastPlanTime = Date.now();
        }
      } else {
        if (cleanLine.startsWith('#') || (STATE.target.total > 0 && cleanLine.length > 20)) {
          CACHE.planMode = false;
        }
      }
    }
  }

  const doneMarkers = (text.match(/✅|✔|Done|completed|Success/gi) || []).length;
  const stepCompletedMatch = text.match(/Step (\d+) completed/i);
  if (stepCompletedMatch) {
    STATE.target.done = Math.max(STATE.target.done, parseInt(stepCompletedMatch[1], 10));
  } else if (doneMarkers > 0 && STATE.target.total > 0) {
    STATE.target.done = Math.min(STATE.target.total, STATE.target.done + doneMarkers);
  }

  if (STATE.target.total > 0) {
    STATE.target.percent = Math.round((STATE.target.done / STATE.target.total) * 100);
  }
};

const parseGeminiOutput = (data) => {
  const text = stripAnsi(data);
  if (CACHE.echoQueue.length > 0) {
    const firstEcho = CACHE.echoQueue[0];
    if (text.includes(firstEcho)) {
      CACHE.echoQueue.shift();
      return; 
    }
  }

  if (!STATE.sessionCount) {
    const modelMatch = text.match(/Model:\s*([^\r\n]+)/i) || text.match(/gemini-\S+/i);
    if (modelMatch) STATE.model = modelMatch[1] || modelMatch[0];
    const tokenMatch = text.match(/Total tokens:\s*([\d,]+)/i) || text.match(/(\d+)\s*\/\s*(\d+)\s*tokens/i);
    if (tokenMatch) STATE.tokenUsed = parseInt(tokenMatch[1].replace(/,/g, ''), 10);
  }

  parseAiPlan(text);
};

// ====================== Rendering ======================
const RENDER_MAP = {
  time: () => CONFIG.hud.show.time ? `🕒 ${STATE.time}` : null,
  cpu: () => CONFIG.hud.show.cpuUsage ? `CPU: ${STATE.cpuPercent}%` : null,
  model: () => CONFIG.hud.show.model ? `[${STATE.model}${STATE.sessionCount > 1 && STATE.model !== 'Multi Gemini Model' ? ` x${STATE.sessionCount}` : ''}]` : null,
  tokens: () => {
    if (!CONFIG.hud.show.tokens) return null;
    const pct = Math.min(100, (STATE.tokenUsed / STATE.tokenMax) * 100) || 0;
    const barLen = CONFIG.hud.progressBar.length;
    const filledLen = Math.floor(pct * barLen / 100);
    const bar = CONFIG.hud.progressBar.full.repeat(filledLen) + CONFIG.hud.progressBar.empty.repeat(barLen - filledLen);
    return `Tokens: ${STATE.tokenUsed}/${STATE.tokenMax} [${bar}] ${pct.toFixed(1)}%`;
  },
  status: () => {
    const color = CONFIG.hud.colors[STATE.status] || '\x1b[0m';
    return `${color}●\x1b[0m ${STATE.activeTool || STATE.status}`;
  },
  target: () => {
    if (!CONFIG.hud.show.target || STATE.target.total === 0) return null;
    return `🎯 ${STATE.target.done}/${STATE.target.total} ${STATE.target.percent}%`;
  }
};

const getFinalOrder = () => {
  const { template, customOrder } = CONFIG.hud.layout;
  if (template === 'custom' && Array.isArray(customOrder) && customOrder.length > 0) return customOrder;
  return LAYOUT_TEMPLATES[template] || LAYOUT_TEMPLATES.default;
};

const renderHUD = throttle(() => {
  const { cols, rows } = CACHE.term;
  const order = getFinalOrder();
  const parts = [];
  for (const key of order) {
    if (RENDER_MAP[key]) {
      const txt = RENDER_MAP[key]();
      if (txt) parts.push(txt);
    }
  }
  const content = parts.join(' | ').substring(0, cols - 1);
  if (content === CACHE.lastHud) return;
  CACHE.lastHud = content;
  if (ansiEscapes.cursorSave) process.stdout.write(ansiEscapes.cursorSave);
  if (ansiEscapes.cursorTo) process.stdout.write(ansiEscapes.cursorTo(0, rows - 1));
  if (ansiEscapes.eraseLine) process.stdout.write(ansiEscapes.eraseLine);
  process.stdout.write(content || '');
  if (ansiEscapes.cursorRestore) process.stdout.write(ansiEscapes.cursorRestore);
}, 1000 / CONFIG.performance.renderFps);

// ====================== Lifecycle ======================
const start = () => {
  const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeVersion < 20) {
    console.error('❌ Error: gemini-hud requires Node.js version 20+');
    process.exit(1);
  }

  const size = getSafeTermSize();
  CACHE.term = size;
  process.stdout.write(ansiEscapes.clearTerminal || '\x1b[2J\x1b[H');
  process.stdout.write(`\x1b[1;${size.rows - CONFIG.hud.rows}r`);
  process.stdout.write(ansiEscapes.cursorTo(0, size.rows - CONFIG.hud.rows - 1));

  console.log(`🚀 gemini-hud starting...`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    if (data.length === 1 && data[0] === 0x03) process.emit('SIGINT');
    const str = data.toString();
    if (str.length > 0) {
      CACHE.echoQueue.push(stripAnsi(str));
      if (CACHE.echoQueue.length > 50) CACHE.echoQueue.shift();
    }
    // Forward all input directly to PTY, no local HUD commands
    if (ptyProc) ptyProc.write(data);
  });

  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', CONFIG.gemini.command] : ['-c', CONFIG.gemini.command];
  const ptyProc = pty.spawn(shell, args, { name: 'xterm-256color', cols: size.cols, rows: size.rows - CONFIG.hud.rows, cwd: process.cwd(), env: process.env });
  
  ptyProc.on('data', data => {
    process.stdout.write(data);
    parseGeminiOutput(data);
  });

  ptyProc.on('exit', (code) => {
    if (code === 0) process.exit(0);
    else if (CONFIG.gemini.autoRestart) setTimeout(() => start(), CONFIG.gemini.restartDelayMs);
    else process.exit(code || 1);
  });

  setInterval(updateSystemTime, 1000);
  updateCpuUsage();
  setInterval(updateCpuUsage, 1000);
  updateGitBranch();
  setInterval(updateGitBranch, CONFIG.performance.gitUpdateIntervalMs);
  updateFilePath();
  setInterval(syncStateFile, 1000);
  setInterval(renderHUD, 1000 / CONFIG.performance.renderFps);
  
  const handleResize = debounce(() => {
    if (CACHE.isResizing) return;
    CACHE.isResizing = true;
    const newSize = getSafeTermSize();
    CACHE.term = newSize;
    process.stdout.write(`\x1b[1;${newSize.rows - CONFIG.hud.rows}r`);
    if (ptyProc) ptyProc.resize(newSize.cols, newSize.rows - CONFIG.hud.rows);
    renderHUD();
    CACHE.isResizing = false;
  }, CONFIG.performance.resizeDebounceMs);
  
  process.stdout.on('resize', handleResize);
  
  process.on('SIGINT', () => {
    process.stdout.write('\x1b[r');
    process.exit(0);
  });
};

start();