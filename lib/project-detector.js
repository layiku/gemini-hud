/**
 * project-detector.js
 *
 * Locates the active Gemini CLI session file by scanning ~/.gemini/tmp/.
 *
 * Detection priority:
 *   1. --project <name> flag  →  use ~/.gemini/tmp/<name>/chats/
 *   2. CWD matching           →  find the project whose .project_root matches cwd
 *   3. Most recently modified →  pick the newest session-*.json across all projects
 *
 * Session kind preference (per Gemini CLI design):
 *   A single gemini-cli process may spawn sub-agents, each writing their own
 *   session file with kind: "subagent". We always prefer kind: "main" files so
 *   we monitor the top-level conversation rather than a transient sub-agent task.
 *   (See: https://github.com/google-gemini/gemini-cli/issues/20258)
 */

import { readdir, readFile, stat, open } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';

const GEMINI_TMP = join(homedir(), '.gemini', 'tmp');

/**
 * Find the path to the most relevant active session JSON file.
 *
 * @param {Object} opts
 * @param {string|null} opts.project - Explicit project name (from --project flag).
 * @param {string} opts.cwd - Current working directory to match against.
 * @returns {Promise<{sessionFile: string, projectName: string}|null>}
 */
export async function detectActiveSession({ project = null, cwd = process.cwd() } = {}) {
  // Strategy 1: explicit --project flag
  if (project) {
    const result = await findLatestSessionInProject(project);
    if (result) return result;
    // Fall through to auto-detection if named project has no sessions yet
  }

  // Strategy 2: CWD matching via .project_root files
  const cwdMatch = await findProjectByCwd(cwd);
  if (cwdMatch) return cwdMatch;

  // Strategy 3: Most recently modified session file across all projects
  return findMostRecentSession();
}

/**
 * Find the latest session file within a named project directory.
 *
 * @param {string} projectName
 * @returns {Promise<{sessionFile: string, projectName: string}|null>}
 */
async function findLatestSessionInProject(projectName) {
  const chatsDir = join(GEMINI_TMP, projectName, 'chats');
  return findLatestSessionInChatsDir(chatsDir, projectName);
}

/**
 * Scan all project directories for one whose .project_root file matches cwd.
 *
 * @param {string} cwd
 * @returns {Promise<{sessionFile: string, projectName: string}|null>}
 */
async function findProjectByCwd(cwd) {
  let projects;
  try {
    projects = await readdir(GEMINI_TMP, { withFileTypes: true });
  } catch {
    return null;
  }

  const normalizedCwd = normalizePath(cwd);

  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    const projectRootFile = join(GEMINI_TMP, entry.name, '.project_root');
    try {
      const content = await readFile(projectRootFile, 'utf8');
      if (normalizePath(content.trim()) === normalizedCwd) {
        const result = await findLatestSessionInProject(entry.name);
        if (result) return result;
      }
    } catch {
      // .project_root doesn't exist for this entry; skip
    }
  }

  return null;
}

/**
 * Find the most recently modified session file across ALL project directories.
 *
 * Applies the same kind-preference logic as findLatestSessionInChatsDir:
 * prefers kind "main" globally before falling back to "subagent" sessions.
 *
 * @returns {Promise<{sessionFile: string, projectName: string}|null>}
 */
async function findMostRecentSession() {
  let projects;
  try {
    projects = await readdir(GEMINI_TMP, { withFileTypes: true });
  } catch {
    return null;
  }

  // Collect the best candidate from each project (already kind-filtered)
  const allCandidates = [];

  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    const chatsDir = join(GEMINI_TMP, entry.name, 'chats');
    const candidate = await findLatestSessionInChatsDir(chatsDir, entry.name);
    if (!candidate) continue;
    try {
      const s = await stat(candidate.sessionFile);
      allCandidates.push({ ...candidate, mtimeMs: s.mtimeMs });
    } catch {
      // Can't stat; skip
    }
  }

  if (allCandidates.length === 0) return null;

  // Prefer main sessions globally, then fall back to subagent
  allCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const mainCandidate = allCandidates.find(c => c.kind === 'main' || c.kind == null);
  const best = mainCandidate ?? allCandidates[0];

  return { sessionFile: best.sessionFile, projectName: best.projectName };
}

/**
 * Find the best session-*.json in a chats/ directory.
 *
 * Selection rules (in priority order):
 *   1. kind === "main"     — most recently modified
 *   2. kind === undefined  — most recently modified (old format without kind field)
 *   3. kind === "subagent" — fallback only if no main/unknown session exists
 *
 * Reading the `kind` field is cheap: it appears within the first ~200 bytes of
 * every session file, so we only read a small header rather than the full JSON.
 *
 * @param {string} chatsDir
 * @param {string} projectName
 * @returns {Promise<{sessionFile: string, projectName: string, kind: string}|null>}
 */
async function findLatestSessionInChatsDir(chatsDir, projectName) {
  let files;
  try {
    files = await readdir(chatsDir);
  } catch {
    return null;
  }

  const sessionFiles = files.filter(f => f.startsWith('session-') && f.endsWith('.json'));
  if (sessionFiles.length === 0) return null;

  // Collect stat + kind for each file
  const candidates = [];
  for (const f of sessionFiles) {
    const fullPath = join(chatsDir, f);
    try {
      const [s, kind] = await Promise.all([
        stat(fullPath),
        readSessionKind(fullPath),
      ]);
      candidates.push({ fullPath, mtimeMs: s.mtimeMs, kind });
    } catch {
      // Skip unreadable files
    }
  }

  if (candidates.length === 0) return null;

  // Sort by mtime descending within each tier, then pick the best tier
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Tier 1: kind "main" or absent (pre-subagent builds had no kind field)
  const mainSession = candidates.find(c => c.kind === 'main' || c.kind === null);
  if (mainSession) return { sessionFile: mainSession.fullPath, projectName, kind: mainSession.kind ?? 'main' };

  // Tier 2: anything else (including "subagent") — just take the newest
  return { sessionFile: candidates[0].fullPath, projectName, kind: candidates[0].kind ?? 'unknown' };
}

/**
 * Read only the first 512 bytes of a session JSON file and extract the `kind` field.
 * Returns null if the field is absent (older builds) or the file is unreadable.
 *
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function readSessionKind(filePath) {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');

    // Match: "kind":"main"  or  "kind": "subagent"  etc.
    const m = head.match(/"kind"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Watch a project's chats/ directory for new session files.
 * Returns an async generator that yields new session file paths as they appear.
 *
 * @param {string} projectName
 * @returns {AsyncGenerator<string>}
 */
export async function* watchForNewSessions(projectName) {
  const chatsDir = join(GEMINI_TMP, projectName, 'chats');
  const { watch } = await import('fs');

  let watcher;
  let resolve;
  const queue = [];

  const enqueue = (filename) => {
    if (filename && filename.startsWith('session-') && filename.endsWith('.json')) {
      const fullPath = join(chatsDir, filename);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(fullPath);
      } else {
        queue.push(fullPath);
      }
    }
  };

  try {
    watcher = watch(chatsDir, (eventType, filename) => {
      if (eventType === 'rename') enqueue(filename);
    });
  } catch {
    return;
  }

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift();
      } else {
        yield await new Promise(r => { resolve = r; });
      }
    }
  } finally {
    watcher.close();
  }
}

/**
 * Normalize a file path for cross-platform comparison.
 * Converts backslashes to forward slashes and lowercases on Windows.
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  const normalized = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Get the display name for a project, given its session file path.
 * Returns the directory name portion (e.g. "gemini-hud" from the path).
 *
 * @param {string} sessionFilePath
 * @returns {string}
 */
export function getProjectDisplayName(sessionFilePath) {
  // Path is: ~/.gemini/tmp/<projectName>/chats/session-*.json
  // Go up two levels: chats -> projectName
  const chatsDir = join(sessionFilePath, '..', '..');
  return basename(chatsDir);
}
