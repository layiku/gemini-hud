# gemini-hud 技术规格说明书

## 文档信息
| 项 | 内容 |
| :--- | :--- |
| **项目名称** | gemini-hud |
| **Spec 版本** | 0.0.3 (早期迭代) |
| **当前状态** | 已完成 |
| **核心目标** | 通过内存级注入实现高精度 Agent 状态监控 |

## 1. System Overview
`gemini-hud` 是一款为 `gemini-cli` 设计的高性能终端状态栏包装器。它利用 Node.js ESM Loader 技术深入底层程序的内存，实时提取最真实的原始数据（Token、模型 ID、处理状态），而不必完全依赖脆弱的终端输出解析。

## 2. 项目架构

```mermaid
graph TD
    A[gemini-hud.js 编排器] -- 1. 启动 PTY --> B[gemini-cli 进程]
    B -- 2. 通过 NODE_OPTIONS 注入 --> C[gemini-esm-hook.js 加载器]
    C -- 3. Hook 构造函数 --> D{Session 会话实例}
    D -- 4. 原始内存数据 --> C
    C -- 5. 通过 Rename 实现原子写入 --> E[.gemini-hud-state.json]
    A -- 6. 定时读取并聚合 --> E
    B -- 7. 标准输出流 --> A
    A -- 8. 正则计划捕获 --> F[内部状态引擎]
    A -- 9. ANSI 转义序列 --> G[终端 HUD 布局]
```

### 2.1 模块说明
- **编排器 (gemini-hud.js)**：主入口程序。管理终端滚动区域，启动 `gemini-cli` 子进程，并聚合遥测数据。
- **钩子插件 (gemini-esm-hook.js)**：专门的 ESM Loader，在字节码层面执行源码转换以捕获内部类实例。
- **状态桥接文件 (.gemini-hud-state.json)**：高性能 JSON 文件，用作进程间通信（IPC）通道。

---

## 3. 实现细节：钩子层 (`gemini-esm-hook.js`)

### 3.1 注入机制
实现 Node.js `load` 钩子以拦截匹配 `@google/gemini-cli-core` 的模块。
- **代码转换**：向 `Session` 类构造函数注入 `globalThis.__HUD_REGISTER_SESSION__(this)`。
- **内存安全**：使用 `WeakRef` 和 `FinalizationRegistry` 确保监控不会阻碍垃圾回收。

### 3.2 I/O 优化与原子性
- **脏检查**：在写入前对比序列化状态，仅当内容变化时才执行磁盘写入。
- **原子写入策略**：为防止并发读写下的竞争条件：
    1. 先将数据写入临时文件 (`.json.tmp`)。
    2. 使用 `fs.renameSync` 瞬间覆盖目标桥接文件。

---

## 4. 实现细节：编排层 (`gemini-hud.js`)

### 4.1 吸附式布局与 PTY
- **吸附性**：启动时清屏并定位光标到 `(rows - 1)`，使输出紧贴 HUD。
- **滚动锁定**：利用 ANSI `\x1b[1;Nr` 定义排除 HUD 行的滚动区域。

### 4.2 聚合逻辑
- **Token 求和**：累加桥接文件中所有活跃会话的 Token 消耗。
- **模型逻辑**：检测到不同模型时显示 `Multi Gemini Model`。
- **状态锁**：仅当 AI 处于 `running` 状态时才激活正则解析引擎。

### 4.3 智能计划捕获
解析 PTY 输出流的状态机：
- **生效条件**：仅在 `全局状态 === running` 时激活。
- **终止条件**：识别到新标题 (`#`) 或计划后的总结性正文块。

### 4.4 回显消除
- 将 `stdin` 输入缓存到 `echoQueue`。
- 过滤 `stdout` 中匹配的内容，防止用户输入干扰计划解析。

---

## 5. 运行环境要求
- **Node.js**：v20.0.0+。
- **启动命令**：
  ```powershell
  $env:NODE_OPTIONS = "--loader file:///C:/path/to/gemini-esm-hook.js"
  node gemini-hud.js
  ```

## 6. 错误处理与清理
- **版本守卫**：若 `node < 20` 则退出。
- **竞争条件处理**：在读取时配合 `try-catch` 以应对极端情况下的文件访问冲突。
- **优雅退出**：在 `SIGINT` 时执行 `\x1b[r` 恢复终端状态。
