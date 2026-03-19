# gemini-hud Technical Specification

## Document Information
| Item | Content |
| :--- | :--- |
| **Project Name** | gemini-hud |
| **Spec Version** | 0.0.5 (AST Injection & IPC) |
| **Status** | Finalized |
| **Core Goal** | High-precision Agent monitoring via memory-level injection |

## 1. System Overview
`gemini-hud` is a high-performance terminal status bar wrapper for `gemini-cli`. It leverages Node.js ESM Loader technology to penetrate the memory of the underlying program, extracting ground-truth data (Tokens, Model IDs, Processing State) without relying solely on fragile terminal output parsing.

## 2. Project Architecture

```mermaid
graph TD
    A[gemini-hud.js Orchestrator] -- 1. Spawn PTY --> B[gemini-cli Process]
    A -- 2. Create IPC Server --> A
    B -- 3. Injected via NODE_OPTIONS --> C[gemini-hud-preload.js (Main Thread)]
    C -- 4. Registers Loader --> D[gemini-hud-loader.js (Worker)]
    D -- 5. Hook Constructor --> E{Session Instances}
    E -- 6. Raw Memory Data --> C
    C -- 7. Stream Data via IPC --> A
    B -- 8. Stdout Stream --> A
    A -- 9. Regex Plan Capture --> F[Internal State Engine]
    A -- 10. ANSI Escape Sequences --> G[Terminal HUD Layout]
```

### 2.1 Module Description
- **Orchestrator (gemini-hud.js)**: The main entry point. It manages the terminal scroll regions, spawns the `gemini-cli` sub-process, and hosts the IPC Server to aggregate telemetry.
- **Hook Plugin (gemini-hud-preload.js & gemini-hud-loader.js)**: Uses the modern `node:module` `register` API. The preload script runs in the main thread to handle memory safety and IPC streaming, while the loader thread transforms bytecode to capture internal instances.
- **IPC Bridge (Named Pipes/Domain Sockets)**: A high-speed, zero-latency, zero-disk I/O communication channel established between the hook and the orchestrator.

---

## 3. Implementation Details: The Hook Layer

### 3.1 Injection Mechanism
Must implement the Node.js `load` hook in a worker thread (`gemini-hud-loader.js`) to intercept modules matching `@google/gemini-cli-core`.
- **Transformation**: Uses Abstract Syntax Tree (AST) parsing (`acorn`, `astring`) to deterministically locate Class constructors and inject `globalThis.__HUD_REGISTER_SESSION__(this)`, making it completely immune to source minification or formatting changes.
- **Memory Safety**: `gemini-hud-preload.js` runs in the main thread, receiving the instance and using `WeakRef` and `FinalizationRegistry` to ensure session monitoring does not prevent garbage collection.

### 3.2 I/O Optimization & IPC
- **Dirty Checking**: The preload script compares the serialized state string before transmitting. It only sends payloads over the socket if the state has actually changed.
- **Zero-Latency Streaming**: Replaced file system polling with `net.Socket`. Payloads are framed using newline characters (`\n`) to ensure clean boundaries across the pipe.

---

## 4. Implementation Details: The Orchestrator Layer (`gemini-hud.js`)

### 4.1 Adherent Layout & PTY
- **Adherence**: On startup, it clears the terminal and repositions the cursor to `(rows - 1)` so that the CLI output appears "glued" to the HUD.
- **Scroll Locking**: Uses ANSI `\x1b[1;Nr` to define a scrolling region that excludes the HUD line.

### 4.2 Aggregation Logic
- **Token Summation**: Sums `input` and `output` tokens from all active sessions received via the IPC socket.
- **Model Logic**: If multiple different models are detected across sessions, displays `Multi Gemini Model`.
- **Status Locking**: Only triggers the Regex-based "Plan Capture" engine when the Hook reports that the AI is in a `running` state.

### 4.3 Echo Cancellation
- Buffers user input from `stdin` into an `echoQueue`.
- Filters `stdout` chunks that match the queue head to prevent user-typed content from being parsed as AI-generated plans.

---

## 5. Runtime Requirements
- **Node.js**: v20.6.0+ (Strict requirement for the modern `module.register` API).
- **Startup Command**:
  ```powershell
  $env:NODE_OPTIONS = "--import file:///C:/path/to/gemini-hud-preload.js"
  node gemini-hud.js
  ```

## 6. Error Handling & Cleanup
- **Version Guard**: Exit if `node < 20.6.0`.
- **Race Conditions**: Handle empty or partial JSON reads during high-frequency updates.
- **Graceful Exit**: Restore scroll region (`\x1b[r`) on `SIGINT` or normal termination.
