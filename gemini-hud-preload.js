import { register } from 'node:module';
import net from 'net';

/**
 * Gemini-HUD ESM Preload (Main Thread)
 * 
 * Handles memory state tracking, dirty checking, and zero-latency IPC
 * via Named Pipes / Domain Sockets to the Orchestrator.
 */

const sessionRefs = new Set();
const cleanupRegistry = new FinalizationRegistry((ref) => sessionRefs.delete(ref));

let lastSerializedState = '';
let ipcSocket = null;
const ipcPath = process.env.GEMINI_HUD_IPC;

if (ipcPath) {
  ipcSocket = net.createConnection(ipcPath);
  ipcSocket.on('error', () => { 
    // Silently ignore errors. If HUD closes, CLI can continue running unmonitored.
  });
}

// Expose the registration function to the global scope of the main thread
globalThis.__HUD_REGISTER_SESSION__ = (session) => {
  const ref = new WeakRef(session);
  sessionRefs.add(ref);
  cleanupRegistry.register(session, ref);
};

/**
 * Capture state and stream over IPC
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
  
  // Only send over IPC if state changed and socket is healthy
  if (currentSerialized !== lastSerializedState && ipcSocket && !ipcSocket.destroyed) {
    // Newline framing guarantees payload boundaries in streams
    ipcSocket.write(currentSerialized + '\n');
    lastSerializedState = currentSerialized;
  }
}, 1000);

// Register the loader hook for source transformation in the loader thread
register('./gemini-hud-loader.js', import.meta.url);
