/**
 * themes.js
 *
 * Named ANSI color themes for gemini-hud.
 *
 * Each theme provides a set of semantic color roles mapped to ANSI escape codes.
 * Themes are applied by the renderer when building each panel line.
 *
 * Built-in themes:
 *   default  — blue accent, white text (original)
 *   dark     — high-contrast cyan/white on dark
 *   minimal  — monochrome, no color except status indicators
 *   ocean    — teal / sky-blue
 *   rose     — magenta / pink
 */

// Raw ANSI fg color codes
const A = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',

  // standard
  black:    '\x1b[30m',
  red:      '\x1b[31m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  blue:     '\x1b[34m',
  magenta:  '\x1b[35m',
  cyan:     '\x1b[36m',
  white:    '\x1b[37m',

  // bright
  bBlack:   '\x1b[90m',
  bRed:     '\x1b[91m',
  bGreen:   '\x1b[92m',
  bYellow:  '\x1b[93m',
  bBlue:    '\x1b[94m',
  bMagenta: '\x1b[95m',
  bCyan:    '\x1b[96m',
  bWhite:   '\x1b[97m',
};

/** @typedef {{ accent: string, label: string, value: string, dim: string, idle: string, processing: string, warn: string, border: string }} Theme */

/** @type {Record<string, Theme>} */
export const THEMES = {
  default: {
    accent:     A.bBlue,
    label:      A.bBlack,
    value:      A.bWhite,
    dim:        A.bBlack,
    idle:       A.bGreen,
    processing: A.bYellow,
    warn:       A.bRed,
    border:     A.blue,
  },
  dark: {
    accent:     A.bCyan,
    label:      A.bBlack,
    value:      A.bWhite,
    dim:        A.bBlack,
    idle:       A.bGreen,
    processing: A.bYellow,
    warn:       A.bRed,
    border:     A.cyan,
  },
  minimal: {
    accent:     A.bold,
    label:      A.dim,
    value:      A.reset,
    dim:        A.dim,
    idle:       A.bGreen,
    processing: A.bYellow,
    warn:       A.bRed,
    border:     A.dim,
  },
  ocean: {
    accent:     A.bCyan,
    label:      A.cyan,
    value:      A.bWhite,
    dim:        A.bBlack,
    idle:       A.bGreen,
    processing: A.bCyan,
    warn:       A.bRed,
    border:     A.cyan,
  },
  rose: {
    accent:     A.bMagenta,
    label:      A.magenta,
    value:      A.bWhite,
    dim:        A.bBlack,
    idle:       A.bGreen,
    processing: A.bMagenta,
    warn:       A.bRed,
    border:     A.magenta,
  },
};

/**
 * Resolve a theme by name. Falls back to 'default' if unknown.
 * Also allows per-key overrides from the config `colors` object.
 *
 * @param {string} name
 * @param {object} [colorOverrides]  - key/value ANSI overrides from .gemini-hudrc
 * @returns {Theme}
 */
export function resolveTheme(name = 'default', colorOverrides = {}) {
  const base = THEMES[name] ?? THEMES.default;
  // Map plain color names (e.g. "cyan") to ANSI codes if the user wrote them in config
  const resolved = {};
  for (const [k, v] of Object.entries(colorOverrides)) {
    resolved[k] = A[v] ?? v; // if it looks like a raw ANSI code, keep it
  }
  return { ...base, ...resolved };
}

export const ANSI = A;
