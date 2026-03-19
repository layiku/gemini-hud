import * as pty from 'node-pty';
import ansiEscapes from 'ansi-escapes';
import stripAnsi from 'strip-ansi';
import { homedir, platform, cpus } from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';

// ====================== 配置类型 ======================
type HudItem = 'time' | 'cpu' | 'model' | 'tokens' | 'mcp' | 'git' | 'path' | 'status' | 'target';
type LayoutTemplate = 'default' | 'minimal' | 'full' | 'dev' | 'clean' | 'custom';

interface HUDConfig {
  rows: number;
  colors: { idle: string; running: string; error: string; };
  show: {
    model: boolean;
    tokens: boolean;
    mcp: boolean;
    target: boolean;
    gitBranch: boolean;
    currentFilePath: boolean;
    time: boolean;
    cpuUsage: boolean;
  };
  progressBar: { full: string; empty: string; length: number; };
  pathStyle: 'short' | 'full';
  layout: {
    template: LayoutTemplate;
    customOrder: HudItem[];
  };
}

interface PerformanceConfig {
  resizeDebounceMs: number;
  resizeThreshold: number;
  renderFps: number;
  gitUpdateIntervalMs: number;
}

interface GeminiConfig {
  command: string;
  autoRestart: boolean;
  restartDelayMs: number;
}

interface Config {
  hud: HUDConfig;
  performance: PerformanceConfig;
  gemini: GeminiConfig;
  paths: { state: string; target: string; globalConfig: string; projectConfig: string; };
}

// ====================== 官方布局模板（claude-hud 风格） ======================
const LAYOUT_TEMPLATES: Record<LayoutTemplate, HudItem[]> = {
  default: ['time', 'model', 'tokens', 'status', 'target'],
  minimal: ['model', 'status'],
  full: ['time', 'cpu', 'model', 'tokens', 'mcp', 'git', 'path', 'status', 'target'],
  dev: ['time', 'cpu', 'git', 'path', 'model', 'tokens', 'mcp', 'status', 'target'],
  clean: ['time', 'tokens', 'status', 'target'],
  custom: []
};

// ====================== 默认配置 ======================
const DEFAULT_CONFIG: Config = {
  hud: {
    rows: 1,
    colors: { idle: '\x1b[32m', running: '\x1b[34m', error: '\x1b[31m' },
    show: {
      model: true,
      tokens: true,
      mcp: true,
      target: true,
      gitBranch: false,
      currentFilePath: false,
      time: false,
      cpuUsage: false
    },
    progressBar: { full: '█', empty: '░', length: 50 },
    pathStyle: 'short',
    layout: {
      template: 'default',
      customOrder: []
    }
  },
  performance: {
    resizeDebounceMs: 30,
    resizeThreshold: 2,
    renderFps: 30,
    gitUpdateIntervalMs: 5000
  },
  gemini: { command: 'gemini-cli', autoRestart: true, restartDelayMs: 5000 },
  paths: {
    state: `${homedir()}/.gemini-hud-state.json`,
    target: `${homedir()}/.gemini-hud-target.txt`,
    globalConfig: `${homedir()}/.gemini-hudrc`,
    projectConfig: join(process.cwd(), '.gemini-hudrc')
  }
};

// ====================== 配置加载 ======================
const loadConfig = (): Config => {
  const merged = { ...DEFAULT_CONFIG };
  const tryLoad = (path: string) => {
    if (existsSync(path)) {
      try { Object.assign(merged, deepMerge(merged, JSON.parse(readFileSync(path, 'utf8')))); }
      catch (e) { console.warn(`⚠️ 配置加载失败：${path}`); }
    }
  };
  tryLoad(merged.paths.globalConfig);
  tryLoad(merged.paths.projectConfig);
  return merged;
};

const deepMerge = (t: any, s: any) => {
  const r = { ...t };
  for (const k in s) {
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) r[k] = deepMerge(r[k] || {}, s[k]);
    else if (s[k] !== undefined) r[k] = s[k];
  }
  return r;
};

const CONFIG = loadConfig();

// ====================== 缓存 ======================
const CACHE = {
  term: { cols: 0, rows: 0 },
  pty: { cols: 0, rows: 0 },
  lastHud: '',
  isResizing: false
};

// ====================== 状态 ======================
interface HUDState {
  model: string;
  tokenUsed: number;
  tokenMax: number;
  activeTool: string | null;
  mcpCount: number;
  status: 'idle' | 'running' | 'error';
  target: { text: string; total: number; done: number; percent: number; };
  gitBranch: string;
  currentFilePath: string;
  time: string;
  cpuPercent: number;
}

const STATE: HUDState = {
  model: 'gemini-1.5-flash',
  tokenUsed: 0,
  tokenMax: 128000,
  activeTool: null,
  mcpCount: 0,
  status: 'idle',
  target: { text: '无目标', total: 0, done: 0, percent: 0 },
  gitBranch: 'no git',
  currentFilePath: '~',
  time: '00:00:00',
  cpuPercent: 0
};

// ====================== 时间模块 ======================
const updateSystemTime = () => {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  STATE.time = `${h}:${m}:${s}`;
};
const startTimeWatcher = () => { updateSystemTime(); setInterval(updateSystemTime, 1000); };

// ====================== CPU 模块 ======================
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
const startCpuWatcher = () => { updateCpuUsage(); setInterval(updateCpuUsage, 1000); };

// ====================== Git 模块 ======================
const getGitBranch = () => {
  exec('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() }, (err, out) => {
    STATE.gitBranch = err ? 'no git' : out.trim();
  });
};
const startGitBranchWatcher = () => { getGitBranch(); setInterval(getGitBranch, CONFIG.performance.gitUpdateIntervalMs); };

// ====================== 路径模块 ======================
const getCurrentFilePath = () => {
  const cwd = process.cwd();
  STATE.currentFilePath = CONFIG.hud.pathStyle === 'short' ? cwd.replace(homedir(), '~') : cwd;
};
const startFilePathWatcher = () => getCurrentFilePath();

// ====================== 工具 ======================
const debounce = (fn: () => void, d: number) => { let t: NodeJS.Timeout; return () => { clearTimeout(t); t = setTimeout(fn, d); }; };
const throttle = (fn: () => void, d: number) => { let l = 0; return () => { const n = Date.now(); if (n - l >= d) { fn(); l = n; } }; };
const getSafeTermSize = () => ({ cols: Math.max(10, process.stdout.columns || 80), rows: Math.max(2, process.stdout.rows || 24) });

// ====================== 滚动区域 ======================
const setScrollRegion = () => { const e = CACHE.term.rows - CONFIG.hud.rows; process.stdout.write(`\x1b[1;${e}r`); };
const resetScrollRegion = () => process.stdout.write('\x1b[r\x1b[?25h');

// ====================== 目标解析 ======================
const parseProgress = (out: string) => {
  if (!STATE.target.total) return;
  STATE.target.done = (out.match(/(✅|完成|已完成)\s*\d+\./g) || []).length;
  STATE.target.percent = Math.min(100, (STATE.target.done / STATE.target.total) * 100);
};

// ====================== Gemini 解析 ======================
const parseGemini = (data: string) => {
  const s = stripAnsi(data);
  const m = s.match(/gemini-\S+/i); if (m) STATE.model = m[0];
  const t = s.match(/(\d+)\s*\/\s*(\d+)\s*tokens?/i) || s.match(/(\d+)\s*tokens?\s*\/\s*(\d+)/i);
  if (t) { STATE.tokenUsed = +t[1]; STATE.tokenMax = +t[2]; }
  const tool = s.match(/Running tool:\s*(\w+)|Executing MCP tool:\s*(\w+)/i);
  if (tool) { STATE.activeTool = tool[1] || tool[2]; STATE.status = 'running'; }
  else if (s.includes('completed') || s.includes('Idle')) { STATE.activeTool = null; STATE.status = 'idle'; }
  if (s.includes('Error') || s.includes('Failed')) STATE.status = 'error';
  parseProgress(s);
};

// ====================== 【核心】按布局顺序渲染（claude-hud 机制） ======================
const RENDER_MAP: Record<HudItem, () => string | null> = {
  time: () => CONFIG.hud.show.time ? `🕒 ${STATE.time}` : null,
  cpu: () => CONFIG.hud.show.cpuUsage ? `CPU: ${STATE.cpuPercent}%` : null,
  model: () => CONFIG.hud.show.model ? `[${STATE.model}]` : null,
  tokens: () => {
    if (!CONFIG.hud.show.tokens) return null;
    const pct = (STATE.tokenUsed / STATE.tokenMax) * 100;
    const bar = CONFIG.hud.progressBar.full.repeat(Math.floor(pct * CONFIG.hud.progressBar.length / 100))
      + CONFIG.hud.progressBar.empty.repeat(CONFIG.hud.progressBar.length - Math.floor(pct * CONFIG.hud.progressBar.length / 100));
    return `Tokens: ${STATE.tokenUsed}/${STATE.tokenMax} [${bar}] ${pct.toFixed(1)}%`;
  },
  mcp: () => CONFIG.hud.show.mcp ? `MCP:${STATE.mcpCount}` : null,
  git: () => CONFIG.hud.show.gitBranch ? `Git: ${STATE.gitBranch}` : null,
  path: () => CONFIG.hud.show.currentFilePath ? `Path: ${STATE.currentFilePath}` : null,
  status: () => {
    const color = CONFIG.hud.colors[STATE.status];
    return `${color}●\x1b[0m ${STATE.activeTool || STATE.status}`;
  },
  target: () => CONFIG.hud.show.target ? `🎯 ${STATE.target.done}/${STATE.target.total} ${STATE.target.percent|0}%` : null
};

const getFinalOrder = (): HudItem[] => {
  const { template, customOrder } = CONFIG.hud.layout;
  if (template === 'custom' && customOrder.length > 0) return customOrder;
  return LAYOUT_TEMPLATES[template] || LAYOUT_TEMPLATES.default;
};

const renderHUD = throttle(() => {
  const { cols, rows } = CACHE.term;
  const hudRow = rows;
  const order = getFinalOrder();
  const parts: string[] = [];

  for (const key of order) {
    const txt = RENDER_MAP[key]();
    if (txt) parts.push(txt);
  }

  const content = parts.join(' | ').substring(0, cols - 1);
  if (content === CACHE.lastHud) return;
  CACHE.lastHud = content;
  process.stdout.write(`\x1b[s\x1b[${hudRow};1H\x1b[2K${content}\x1b[u`);
}, 1000 / CONFIG.performance.renderFps);

// ====================== PTY ======================
let ptyProc: pty.IPty | null = null;
const spawnOrResizePty = () => {
  const { cols, rows } = CACHE.term;
  const ptyRows = rows - CONFIG.hud.rows;
  const sz = { cols, rows: ptyRows };
  if (sz.cols === CACHE.pty.cols && sz.rows === CACHE.pty.rows) return;
  CACHE.pty = sz;
  if (ptyProc) return ptyProc.resize(cols, ptyRows);

  ptyProc = pty.spawn(CONFIG.gemini.command, [], { name: 'xterm-256color', cols, rows: ptyRows, cwd: process.cwd(), env: process.env });
  ptyProc.on('data', d => { process.stdout.write(d); parseGemini(d); });
  process.stdin.on('data', d => {
    ptyProc!.write(d);
    const line = d.toString().trim();
    if (line.startsWith('target: ')) {
      const t = line.slice(8).trim();
      STATE.target = { text: t, total: (t.match(/\d+\.\s+/g) || []).length, done: 0, percent: 0 };
    }
  });
  ptyProc.on('exit', () => {
    if (!CONFIG.gemini.autoRestart) process.exit(0);
    setTimeout(() => { ptyProc = null; spawnOrResizePty(); }, CONFIG.gemini.restartDelayMs);
  });
};

// ====================== 缩放 ======================
const handleResize = debounce(() => {
  if (CACHE.isResizing) return;
  CACHE.isResizing = true;
  const sz = getSafeTermSize();
  CACHE.term = sz;
  setScrollRegion();
  spawnOrResizePty();
  getCurrentFilePath();
  renderHUD();
  CACHE.isResizing = false;
}, CONFIG.performance.resizeDebounceMs);

// ====================== 启动 ======================
const start = () => {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  CACHE.term = getSafeTermSize();
  setScrollRegion();
  spawnOrResizePty();
  startTimeWatcher();
  startCpuWatcher();
  startGitBranchWatcher();
  startFilePathWatcher();

  setInterval(renderHUD, 1000 / CONFIG.performance.renderFps);
  process.stdout.on('resize', handleResize);
  process.on('SIGINT', () => { resetScrollRegion(); console.log('\n👋 已退出'); process.exit(0); });
  console.log('🚀 gemini-hud 已启动 | 模板切换：default/minimal/full/dev/clean | Ctrl+C 退出');
};

start();