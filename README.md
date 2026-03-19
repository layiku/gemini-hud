# gemini-hud (v0.0.5-dev)

[English](README.md) | [中文](README_zh.md)

A high-performance terminal status bar (HUD) for Gemini CLI. It leverages **ESM Loader Injection** to provide 100% accurate, real-time monitoring of tokens, models, and multi-session states directly from memory.

## Core Features

- **AST-Based Runtime Injection**: Uses Abstract Syntax Tree (AST) parsing via Node.js Loaders to safely inject telemetry hooks into `gemini-cli` memory, guaranteeing 100% accurate data (Tokens, Model ID, Status) regardless of upstream code minification.
- **Multi-Session Aggregation**: Automatically aggregates resource usage across all concurrent Agent sessions. Supports `Multi Gemini Model` detection.
- **Smart Plan Capture**: Automatically extracts task lists from AI Markdown responses (`## Plan`).
- **Echo Cancellation**: Advanced filtering prevents your terminal input from interfering with HUD status parsing.
- **Adherent Layout**: Fixed bottom status bar with a "glued" CLI output layout that prevents empty gaps on startup.
- **Resource Optimized**: Features "Dirty Checking" and Zero-Latency IPC via Named Pipes to completely eliminate disk I/O, using `WeakRef` to ensure zero memory leaks.
- **Pseudo Terminal Isolation**: Independent PTY partition ensures your CLI experience remains smooth and responsive.

## Requirements

1. **Node.js 20.0.0+** (Required for ESM Loader API support)
2. Standard `gemini-cli` installed and configured.
3. A terminal supporting ANSI escape sequences (Windows Terminal, iTerm2, etc.)

## Installation

```bash
# Install dependencies
npm install pty.js ansi-escapes strip-ansi
```

## Quick Start

To enable high-precision monitoring, you must inject the HUD hook using the `NODE_OPTIONS` environment variable.

### Windows (PowerShell)
```powershell
$env:NODE_OPTIONS = "--import file:///C:/path/to/gemini-hud-preload.js"
node gemini-hud.js
```

### Linux / macOS
```bash
NODE_OPTIONS="--import ./gemini-hud-preload.js" node gemini-hud.js
```

## Configuration Guide

gemini-hud supports multi-level configuration. It resolves settings in the following order of priority:
1. **Project-level**: `.gemini-hudrc` in the current working directory.
2. **Global-level**: `~/.gemini-hudrc` in your user home directory.
3. **Defaults**: Built-in hardcoded values.

> **💡 Important**: To customize your settings, you must rename the provided `.gemini-hudrc.example` file to `.gemini-hudrc` in your project or home directory. If no config file is found, the program will run using its internal defaults.

### Full Configuration Example (`.gemini-hudrc`)

```json
{
  "hud": {
    "rows": 1,
    "colors": {
      "idle": "\u001b[32m",
      "running": "\u001b[34m",
      "error": "\u001b[31m"
    },
    "show": {
      "model": true,
      "tokens": true,
      "mcp": true,
      "target": true,
      "gitBranch": true,
      "currentFilePath": true,
      "time": true,
      "cpuUsage": true
    },
    "progressBar": {
      "full": "█",
      "empty": "░",
      "length": 30
    },
    "pathStyle": "short",
    "layout": {
      "template": "default",
      "customOrder": []
    }
  },
  "performance": {
    "resizeDebounceMs": 50,
    "renderFps": 30,
    "gitUpdateIntervalMs": 5000
  },
  "gemini": {
    "command": "gemini",
    "autoRestart": true,
    "restartDelayMs": 5000
  }
}
```

### Detailed Parameter Reference

#### 1. HUD Appearance (`hud`)
| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `rows` | Number | `1` | Number of terminal rows reserved for the HUD. |
| `colors.idle` | String | `\x1b[32m` | Color for idle state (Green). |
| `colors.running` | String | `\x1b[34m` | Color for processing state (Blue). |
| `colors.error` | String | `\x1b[31m` | Color for error state (Red). |
| `show.*` | Boolean | `true` | Toggle specific items (model, tokens, mcp, target, etc.). |
| `progressBar.full` | String | `"█"` | Character for filled progress. |
| `progressBar.empty` | String | `"░"` | Character for empty progress. |
| `progressBar.length`| Number | `30` | Length of the Token/Progress bar. |
| `pathStyle` | String | `"short"`| `"short"` (with `~`) or `"full"` (absolute). |
| `layout.template` | String | `"default"`| `default`, `minimal`, `full`, `dev`, `clean`, `custom`. |
| `layout.customOrder`| Array | `[]` | Order of keys when template is `"custom"`. |

#### 2. Performance (`performance`)
| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `resizeDebounceMs` | Number | `50` | Delay before re-rendering after terminal resize. |
| `renderFps` | Number | `30` | Maximum UI refresh rate per second. |
| `gitUpdateIntervalMs`| Number | `5000` | Frequency of Git branch background checks. |

#### 3. Gemini Core (`gemini`)
| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `command` | String | `"gemini"` | The actual command used to start Gemini CLI. |
| `autoRestart` | Boolean | `true` | Whether to relaunch Gemini after a non-zero exit. |
| `restartDelayMs` | Number | `5000` | Delay before automatic restart. |

## Advanced Features

### Automatic Plan Tracking
The HUD "eavesdrops" on AI responses. When the AI outputs a plan like:
```markdown
## Plan
1. Fix bug A
2. Test feature B
```
The HUD will automatically display `🎯 0/2`. As the AI outputs `✅` or `Step 1 completed`, the progress bar updates in real-time.

## FAQ

### Q: Why does it require Node 20?
It uses the latest ESM Loader Hooks to perform code injection without modifying the `gemini-cli` source files. This API is only stable in Node 20+.

### Q: Does it slow down the AI?
No. The hook performs "Dirty Checking" in memory and transmits data via a zero-latency IPC Named Pipe only when data actually changes (e.g., when a new token is generated). There is zero disk I/O overhead.

## License
MIT License
