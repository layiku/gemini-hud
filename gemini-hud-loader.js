import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { generate } from 'astring';

/**
 * Gemini-HUD ESM Loader (Worker Thread) - AST Parsing Edition
 * 
 * Uses Abstract Syntax Tree (AST) to safely and reliably inject telemetry hooks 
 * into the target program, making it immune to source code formatting or minification.
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  // Target the session file or the main core bundle
  if (url.includes('session.js') || url.includes('@google/gemini-cli-core')) {
    const sourceStr = result.source.toString();
    
    try {
      // 1. Parse the source into an AST
      const ast = parse(sourceStr, { ecmaVersion: 'latest', sourceType: 'module' });
      let modified = false;

      // The code payload to inject, pre-parsed as an AST node
      const payloadStr = "if (globalThis.__HUD_REGISTER_SESSION__) globalThis.__HUD_REGISTER_SESSION__(this);";
      const injectionNode = parse(payloadStr, { ecmaVersion: 'latest' }).body[0];

      // 2. Traverse the AST to find class constructors
      simple(ast, {
        MethodDefinition(node) {
          if (node.kind === 'constructor') {
            // 3. Inject our payload at the end of the constructor's execution block
            if (node.value && node.value.body && Array.isArray(node.value.body.body)) {
              node.value.body.body.push(injectionNode);
              modified = true;
            }
          }
        }
      });

      // 4. Generate the new source string from the modified AST
      if (modified) {
        result.source = generate(ast);
        // Uncomment to debug successful injection
        // console.log(`[HUD AST Hook] Successfully injected telemetry into ${url}`);
      }
    } catch (e) {
      // Silent fail fallback: if AST parsing fails (e.g. extremely weird minification), 
      // it just returns the original unhooked code to prevent crashing the CLI.
      console.warn(`⚠️ [HUD AST Hook] Warning: Failed to parse AST for ${url}: ${e.message}`);
    }
  }

  return result;
}
