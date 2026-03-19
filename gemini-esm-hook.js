import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

/**
 * Gemini-HUD ESM Hook 插件 (Leak-Free & Atomic Optimized)
 */

const STATE_FILE = path.join(homedir(), '.gemini-hud-state.json');
const TEMP_FILE = STATE_FILE + '.tmp'; // 临时文件用于原子写入
const sessionRefs = new Set();
const cleanupRegistry = new FinalizationRegistry((ref) => sessionRefs.delete(ref));

let lastSerializedState = '';

globalThis.__HUD_REGISTER_SESSION__ = (session) => {
  const ref = new WeakRef(session);
  sessionRefs.add(ref);
  cleanupRegistry.register(session, ref);
};

/**
 * 原子化写入：先写临时文件，再重命名，彻底杜绝读取竞争
 */
setInterval(() => {
  const sessionList = [];

  for (const ref of sessionRefs) {
    const s = ref.deref();
    if (s) {
      sessionList.push({
        id: s.id || 'default',
        model: s.model?.id || 'unknown',
        tokens: {
          input: s.stats?.tokens?.input || 0,
          output: s.stats?.tokens?.output || 0
        },
        isProcessing: !!s.isProcessing,
        activeTool: s.activeTool?.name || null
      });
    }
  }

  const currentSerialized = JSON.stringify(sessionList);
  if (currentSerialized !== lastSerializedState) {
    try {
      // 1. 写入临时文件
      fs.writeFileSync(TEMP_FILE, currentSerialized);
      // 2. 原子重命名覆盖目标文件 (POSIX 和 Windows 大多支持)
      fs.renameSync(TEMP_FILE, STATE_FILE);
      
      lastSerializedState = currentSerialized;
    } catch (e) {
      // 如果重命名失败（可能文件被占用），下次循环重试
    }
  }
}, 1000);

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.includes('session.js') || url.includes('@google/gemini-cli-core')) {
    let source = result.source.toString();
    if (source.includes('constructor')) {
      source = source.replace(
        /constructor\s*\(([^)]*)\)\s*\{([\s\S]*?)\}/,
        (match, args, body) => {
          return `constructor(${args}) { ${body}; globalThis.__HUD_REGISTER_SESSION__?.(this); }`;
        }
      );
      result.source = source;
    }
  }
  return result;
}

console.log('🚀 Gemini-HUD ESM Hook (Atomic Optimized) Loaded.');
