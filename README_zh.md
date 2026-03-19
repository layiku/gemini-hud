# gemini-hud (v0.0.3-dev)

[中文](README_zh.md) | [English](README.md)

一款为 Gemini CLI 设计的高性能终端状态栏（HUD）。它利用 **ESM Loader 注入技术**，直接从内存中提取 100% 准确的 Token 用量、模型型号以及多会话状态，实现真正实时的可视化监控。

## 核心特性

- **运行时注入监控**：通过 Node.js Loader 钩入 `gemini-cli` 内存，获取最真实的数据（Token、模型 ID、运行状态）。
- **多会话聚合**：自动累加所有并发 Agent 会话的资源消耗。支持 `Multi Gemini Model` 冲突检测。
- **全自动计划捕获**：自动从 AI 的 Markdown 回复中提取任务列表（`## Plan`）。
- **回显消除机制**：先进的过滤算法，确保你的终端输入不会干扰 HUD 的状态解析。
- **吸附式布局**：固定底部的状态栏，采用“吸附”技术消除启动时的空白间隙，使输出紧贴 HUD。
- **极致资源优化**：内置“脏检查”机制并采用命名管道 (Named Pipes) 实现零延迟 IPC 通信，彻底消除磁盘 I/O。使用 `WeakRef` 确保长时间运行零内存泄漏。
- **伪终端隔离**：独立的 PTY 分区，确保 CLI 交互顺滑、响应及时。

## 运行要求

1. **Node.js 20.0.0+** (必须，以支持最新的 ESM Loader API)
2. 已安装并配置标准版 `gemini-cli`。
3. 支持 ANSI 转义序列的终端（如 Windows Terminal, iTerm2 等）。

## 安装

```bash
# 安装必要依赖
npm install pty.js ansi-escapes strip-ansi
```

## 快速开始

要激活高精度监控，你必须通过 `NODE_OPTIONS` 环境变量注入 HUD 钩子。

### Windows (PowerShell)
```powershell
$env:NODE_OPTIONS = "--import file:///C:/路径/到/gemini-hud-preload.js"
node gemini-hud.js
```

### Linux / macOS
```bash
NODE_OPTIONS="--import ./gemini-hud-preload.js" node gemini-hud.js
```

## 配置指南

gemini-hud 支持多层级配置覆盖，加载优先级如下：
1. **项目级**：当前工作目录下的 `.gemini-hudrc`。
2. **全局级**：用户家目录下的 `~/.gemini-hudrc`。
3. **内置默认**：程序内部硬编码的初始设置。

> **💡 重要提醒**：若要自定义配置，你需要将项目中的 `.gemini-hudrc.example` 文件重命名为 `.gemini-hudrc`（放在当前目录或家目录均可）。如果程序未找到任何配置文件，将自动按照内置代码的默认值运行。

### 完整配置示例 (`.gemini-hudrc`)

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

### 详细参数参考

#### 1. HUD 外观配置 (`hud`)
| 键名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `rows` | 数字 | `1` | 为 HUD 预留的终端行数。 |
| `colors.idle` | 字符串 | `\x1b[32m` | 空闲状态颜色（绿色）。 |
| `colors.running` | 字符串 | `\x1b[34m` | 运行/思考中状态颜色（蓝色）。 |
| `colors.error` | 字符串 | `\x1b[31m` | 错误状态颜色（红色）。 |
| `show.*` | 布尔值 | `true` | 各监控项的显示开关（模型、Token、任务等）。 |
| `progressBar.full` | 字符串 | `"█"` | 进度条已填充部分的字符。 |
| `progressBar.empty` | 字符串 | `"░"` | 进度条未填充部分的字符。 |
| `progressBar.length`| 数字 | `30` | Token/任务进度条的字符长度。 |
| `pathStyle` | 字符串 | `"short"`| 路径风格：`"short"` (带 `~`) 或 `"full"` (绝对路径)。 |
| `layout.template` | 字符串 | `"default"`| 布局模板：`default`, `minimal`, `full`, `dev`, `clean`, `custom`。 |
| `layout.customOrder`| 数组 | `[]` | 当模板为 `"custom"` 时，定义监控项的显示顺序。 |

#### 2. 性能与采集 (`performance`)
| 键名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `resizeDebounceMs` | 数字 | `50` | 窗口缩放后重新渲染的防抖延迟。 |
| `renderFps` | 数字 | `30` | 状态栏每秒最大刷新率。 |
| `gitUpdateIntervalMs`| 数字 | `5000` | 后台检查 Git 分支变化的频率。 |

#### 3. Gemini 核心配置 (`gemini`)
| 键名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `command` | 字符串 | `"gemini"` | 启动底层 Gemini CLI 的实际命令。 |
| `autoRestart` | 布尔值 | `true` | 当 Gemini 非正常退出时是否自动重新启动。 |
| `restartDelayMs` | 数字 | `5000` | 自动重启前的等待延迟。 |

## 高级功能

### 自动任务追踪
HUD 会自动“旁听” AI 的回复。当 AI 输出类似以下的计划时：
```markdown
## Plan
1. 修复 Bug A
2. 测试功能 B
```
状态栏将自动显示 `🎯 0/2`。随着 AI 输出 `✅` 或 `Step 1 completed`，进度条会实时跳动。

## 常见问题

### 问：为什么需要 Node 20？
因为它使用了最新的 ESM Loader Hooks 技术，可以在不修改 `gemini-cli` 源码文件的情况下实现代码注入。该 API 在 Node 20+ 版本中才趋于稳定。

### 问：它会拖慢 AI 的运行速度吗？
不会。钩子在内存中执行“脏检查”，只有当数据真正发生变化（例如生成了新 Token）时，才会通过零延迟的 IPC 命名管道发送数据。没有任何磁盘 I/O 开销，极其轻量。

## 许可证
MIT License
