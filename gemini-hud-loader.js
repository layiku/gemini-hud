/**
 * Gemini-HUD ESM Loader (Worker Thread)
 * 
 * Runs in a separate loader thread. Intercepts and transforms the 
 * Session class to inject the memory hook.
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.includes('session.js') || url.includes('@google/gemini-cli-core')) {
    let source = result.source.toString();
    if (source.includes('constructor')) {
      source = source.replace(
        /constructor\s*\(([^)]*)\)\s*\{([\s\S]*?)\}/,
        (match, args, body) => {
          // Injects a call to the global function defined in the main thread
          return `constructor(${args}) { ${body}; globalThis.__HUD_REGISTER_SESSION__?.(this); }`;
        }
      );
      result.source = source;
    }
  }
  return result;
}
