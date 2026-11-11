# 🌐 Universal Cross-IDE & Cross-Harness Intercom Architecture (`intercom-global`)

> **Package**: `{{PROJECT_NAME}}`  
> **Status**: Production Architecture Specification  
> **Target Runtimes**: `{{SUPPORTED_HARNESSES}}` (Active detected: `{{ACTIVE_HARNESSES}}`)  
> **Document Version**: {{PROJECT_VERSION}}  
> **Snapshot Date**: {{CURRENT_DATE}} (Last Synced: {{LAST_SYNCED_AT}})  
> **Author**: Teamwork Architecture Group (Milestone 1)  

---

## 1. Executive Summary & Problem Analysis

In modern multi-agent software engineering, autonomous coding agents operate across heterogeneous environments:
- Visual IDEs with embedded AI copilots (Google Antigravity, Cursor, Windsurf, VS Code with Cline or Roo Code).
- Headless terminal coding harnesses and command-line execution runners (Claude Code, OpenCode CLI, Alibaba Qoder, MiniMax M-Code).
- Autonomous cloud execution environments (Google Jules on cloud VMs, Devin).

Prior implementations of cross-agent communication frameworks suffered from fatal structural defects when executed in real-world, concurrent engineering environments:

### 1.1 Fatal Structural Defects in Legacy Intercom Systems

1. **Read-Modify-Write Concurrency Races in Monolithic Mailboxes**:
   Legacy implementations stored an agent's entire queue as a single JSON array inside `mesh/<agent>.json`. When multiple parent orchestrators or peer agents dispatched tasks simultaneously:
   - Agent A read `mesh/worker.json` containing `[msg1]`.
   - Agent B read `mesh/worker.json` containing `[msg1]`.
   - Agent A appended `msgA` and wrote `[msg1, msgA]` via temporary file rename.
   - Agent B appended `msgB` and wrote `[msg1, msgB]` via temporary file rename.
   - **Result**: `msgA` was completely erased and permanently lost without trace or warning.

2. **Windows NTFS File Locking Semantics & `fs.renameSync` / `fs.unlinkSync` Failures**:
   On Windows NTFS filesystems, both sender writes (`fs.renameSync`) and receiver acknowledgments (`fs.unlinkSync` or `fs.renameSync` into archive) throw `EPERM` or `EBUSY` whenever target files are momentarily held open by background processes—including file watchers, antivirus real-time scanners, IDE search indexers, or concurrent readers. In legacy systems, fallbacks to `fs.writeFileSync` during active contention resulted in file truncation and `SyntaxError: Unexpected end of JSON input`, while unhandled `unlinkSync` failures caused duplicated message processing. Defeating this requires coordinated exponential backoff retry loops on both senders and receivers.

3. **Fatal Signal Incompatibility on Windows (Win32)**:
   POSIX asynchronous signals (`SIGUSR1`, `SIGUSR2`, `SIGHUP`) do **not exist** in the Windows Win32 API. In Node.js on Windows, attempting `process.kill(pid, 'SIGUSR1')` throws an unhandled exception or maps to unconditional `TerminateProcess`, fatally killing the target agent rather than interrupting or steering it.

4. **Lack of Dual-Transport Bifurcation**:
   Systems relying exclusively on HTTP ports failed when agents restarted or operated in headless batch loops where ports were unassigned. Systems relying exclusively on disk polling incurred 100ms–2000ms latencies unacceptable for real-time human-in-the-loop steering or process preemption.

### 1.2 The Solution: `intercom-global` Architecture

`intercom-global` resolves these fundamental tensions through a **Defense-in-Depth, Dual-Transport Architecture**:
- **Fast-Path**: High-velocity local loopback HTTP/WebSocket daemon (`{{DAEMON_URL}}`) delivering messages and interruption events in **$\le 5\text{ms}$**.
- **Safe-Path**: Zero-dependency **Discrete Atomic File-Mesh** (`mesh/inbox/<recipient>/<timestamp>_<uuid>.json`) guaranteeing **100% zero-drop delivery** through mathematically independent, append-only file operations.
- **Heterogeneous Interruption Engine**: Environment-native interruption adapting to each platform's lifecycle (stdin injection, ConPTY emulation, SSE cancellations, MCP tool interrupts).
- **Google Jules Cloud Delegation**: Single-file heavy-lift routing (>100 LOC modifications, complex AST rewrites, test suites) with strict 1–3 file bounds and concurrency gating.
- **Zero-Kill Governance**: Absolute preservation of running agent sessions with bounded reuse caps (3 to 10 iterations).

---

## 2. System Overview & Dual-Transport Topologies

The framework decouples message transmission into two complementary planes: the **Real-Time Control Plane (Fast-Path)** and the **Durable Storage Plane (Safe-Path)**.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   SENDER (Orchestrator / Peer / User)                                  │
└───────────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                                    │
                                   Universal Intercom Router / Dispatcher
                                                    │
                   ┌────────────────────────────────┴────────────────────────────────┐
                   ▼                                                                 ▼
      Fast-Path: Direct IPC / REST                                       Safe-Path: Discrete File-Mesh
      (Latency: <= 5ms)                                                  (Latency: 10ms - 50ms, Zero-Loss)
                   │                                                                 │
    Is Target Online on Port / Pipe?                                    Write Immutable Discrete Message:
                   │                                                    mesh/inbox/<agent>/<ts>_<uuid>.json
        ┌──────────┴──────────┐                                                      │
       YES                    NO                                         Atomic Write -> Rename (.tmp -> .json)
        │                      │                                                     │
 ┌──────▼────────┐     ┌───────▼──────────────────────────┐                          │
 │ Direct Socket │     │ Route to Safe-Path File-Mesh     │                          │
 │ Delivery via  │     │ and signal agent via wake hook   │                          │
 │ HTTP/WS/PTY   │     └──────────────────────────────────┘                          │
 └──────┬────────┘                                                                   │
        │                                                                            │
        └───────────────────────────────┬────────────────────────────────────────────┘
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   RECIPIENT AGENT PLATFORMS                                            │
├─────────────────────┬───────────────────┬───────────────────┬────────────────────┬─────────────────────┤
│ Google Antigravity  │ Cursor / Windsurf │ VS Code / Cline   │ Terminal Harnesses │ Google Jules        │
│ Task Bridge & MCP   │ Stdio MCP & Watch │ Named Pipes & MCP │ Stdin / ConPTY     │ Cloud VM Delegation │
└─────────────────────┴───────────────────┴───────────────────┴────────────────────┴─────────────────────┘
```

### 2.1 Fast-Path Transport (HTTP / WebSockets / Named Pipes)

The Fast-Path is active whenever an agent or daemon is running and reachable on loopback:
- **Port Allocation**: Dedicated loopback HTTP and WebSocket server listening on `127.0.0.1:{{DAEMON_PORT}}` (configurable via `INTERCOM_PORT`).
- **Full-Duplex WebSockets**: Persistent duplex channel `ws://127.0.0.1:{{DAEMON_PORT}}/ws?agent=<agentName>` allowing immediate push notifications with $<2\text{ms}$ latency.
- **Server-Sent Events (SSE)**: Unidirectional streaming endpoint `GET /api/events?agent=<agentName>` for lightweight clients and browser-based interfaces.
- **Named Pipes (Windows)**: High-speed local Win32 Named Pipe (`\\.\pipe\intercom-<agentName>`) using length-prefixed binary framing for environments where TCP sockets are restricted.
- **Unix Domain Sockets (POSIX)**: Local socket file (`/tmp/intercom-<agentName>.sock`) on Linux/macOS.

### 2.2 Safe-Path Transport (Discrete Atomic File-Mesh)

When an agent process is paused, restarting, executing a long-running compile step, or operating in an air-gapped terminal session, messages automatically divert to or simultaneously register in the Safe-Path:

```
~/.intercom-global/mesh/
├── registry/
│   ├── orchestrator.json                # Agent State Card
│   ├── worker_m1.json                   # Agent State Card
│   └── explorer_1.json                  # Agent State Card
├── inbox/
│   ├── worker_m1/
│   │   ├── 1730000001000_3fa85f64.json  # Discrete immutable message
│   │   └── 1730000005200_7b29a1c8.json  # Discrete immutable message
│   └── orchestrator/
│       └── 1730000012000_9e12c4b5.json  # Discrete immutable message
├── locks/
│   └── registry.lock/                   # Directory CAS lock (with TTL)
└── archive/
    └── {{CURRENT_DATE}}/
        └── worker_m1/                   # Acknowledged/processed messages
```

#### The Discrete Message File Invariant
1. **No Monolithic Arrays**: No two processes ever attempt to write to or modify the same file. Every message is assigned a distinct UUIDv4 and epoch timestamp.
2. **Atomic Write-and-Rename Protocol**:
   - The sender serializes the JSON message into a temporary file within the recipient's inbox directory: `mesh/inbox/<recipient>/.tmp_<uuid>.tmp`.
   - The sender invokes `fs.renameSync(tmpPath, finalPath)` where `finalPath` is `mesh/inbox/<recipient>/<timestamp>_<uuid>.json`.
   - Because `finalPath` is globally unique, Windows NTFS never experiences destination file conflicts.
3. **Safe Consumption & Acknowledgment**:
   - The receiving agent lists files in its inbox directory using `fs.readdirSync`.
   - Files are sorted chronologically by the embedded timestamp prefix.
   - Once a message is ingested and executed, the receiver acknowledges delivery by moving it to `mesh/archive/<date>/<recipient>/` or unlinking it.
   - **Receiver-Side NTFS Retry Loop**: To handle transient locks from Windows Defender, antivirus scanners, or search indexers during acknowledgment, both `fs.unlinkSync` and `fs.renameSync` are wrapped in a 5-attempt retry loop with exponential backoff (20ms, 40ms, 80ms, 160ms, 320ms + randomized jitter) on `EBUSY` or `EPERM`.
   - If the agent crashes mid-execution prior to acknowledgment, unacknowledged message files remain safely in the inbox for recovery upon restart.

### 2.3 Compare-And-Swap (CAS) Directory Advisory Locking

For shared resources requiring serialized access (such as pruning the agent registry or archiving stale messages), `intercom-global` utilizes **Directory-Based CAS Locking**:
- In POSIX and Windows Win32 filesystems, `mkdir` is an atomic operating system primitive. If directory creation succeeds, the lock is acquired. If it fails with `EEXIST`, the lock is currently held by another worker.
- **Stale Lock Recovery (3-Second TTL)**: Every lock directory contains a `metadata.json` recording `{ ownerPid, createdAt }`. If a lock is held longer than 3,000ms, contending processes verify if `ownerPid` is dead (via `process.kill(pid, 0)`) or expired, safely breaking the stale lock and preventing distributed deadlocks.

---

## 3. Complete Cross-IDE Interruption Matrix (7 Environments)

The following matrix provides the definitive, production-grade mapping of Inter-Process Communication (IPC), interruption mechanisms, fallback protocols, and security boundaries across all 7 supported environments:

| Target Environment | Primary IPC Transport | Fallback IPC Mechanism | Interruption Capability & Latency | Windows Compatibility & Runtime Caveats | Security & Path Isolation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Google Antigravity** | Model Context Protocol (`intercom-mcp`) via stdio + Local HTTP Daemon (`:{{DAEMON_PORT}}`) | Discrete File-Mesh (`.agents/mesh/`) with `/schedule` polling timers | **Active Supervisor Steer**: `<50ms` via `manage_task(Action="send_input")` or `send_message`. Reactive wakeup via scheduler. | Fully compatible. Node.js runtime executes natively on Windows 10/11. Powershell shell runner. | Strict workspace sandboxing; path validation enforces containment within authorized project roots. |
| **2. Cursor IDE** | Stdio MCP Server (`intercom-mcp`) + `@cursor/sdk` integration | Reactive Mailbox Watcher (`intercom watch` with FS events) | **Tool Cancellation**: `<20ms` via MCP JSON-RPC `$/cancelRequest` (do NOT inject raw `\x03` into stdio). Mailbox wakeup: `<80ms`. | Fully compatible. VS Code Electron backend manages pipes and subagent stdio cleanly. | Cursor workspace isolation; token-authenticated MCP endpoints. |
| **3. Windsurf (Cascade)** | Cascade MCP Server (`serverUrl` or stdio in `mcp_config.json`) | Atomic Mailbox Watcher (`mesh/inbox/`) | **Cascade Tool Abort**: `<30ms` via MCP abort signal or JSON-RPC cancel (no raw `\x03`). Mailbox wakeup: `<100ms`. | Fully compatible. Windsurf requires explicit `serverUrl` or absolute path to node binary in config. | Loopback `127.0.0.1` binding; Cascade user permission gates preserved. |
| **4. VS Code / Cline / Roo Code** | VS Code Extension Host IPC (Named Pipes `\\.\pipe\vscode-ipc-*`) + Stdio MCP | FileSystemWatcher API (`vscode.workspace.createFileSystemWatcher`) | **Webview / Runner Abort**: `<15ms` via AbortController in Extension Host. MCP hook: `<30ms` via `$/cancelRequest`. | Fully compatible. Native Win32 Named Pipes supported directly by VS Code core. | Extension Host sandbox isolation; URI scheme validation. |
| **5. Claude Code (`claude`)** | Headless CLI Stream (`claude -p` with piped stdin & JSON output) | Session Bridge (`intercom bridge`) with active stdin injection | **Process Interruption**: `<10ms` via `child.stdin.write` with preemption tokens. | Fully compatible in headless `-p` mode. Interactive TUI requires ConPTY emulation via `node-pty`. | Enforce `--allowedTools` constraints and `--permission-mode acceptEdits`. |
| **6. OpenCode CLI (`opencode`)** | Local REST Server (`POST /session/:id/prompt_async` on `:4096`) | Headless CLI invocation (`opencode --auto`) + Mailbox Journal | **Async Injection**: `<5ms` via non-blocking HTTP REST call. Full SSE streaming. | Fully compatible. Go/Node binaries execute natively on Windows without POSIX shims. | Localhost isolation (`127.0.0.1`); optional HTTP Basic Auth (`OPENCODE_SERVER_PASSWORD`). |
| **7. Alibaba Qoder (`qoder`)** | Headless CLI (`qoder -p` with `--bypass-permissions` & `--session-id`) | Stdin stream pipe + Mailbox Journal | **Interrupt & Budget Cap**: `<15ms` via stdin write; `--thinking-budget` hard-limits execution turns. | Fully compatible. Win32 console process group allows clean execution. | Git worktree isolation (`--worktree`) prevents dirty repository mutations. |

---

## 4. Comprehensive Breakdown of Interruption Mechanics

Real-time interruption of autonomous coding agents is required when:
- An orchestrator detects an invalid execution trajectory or regression.
- A human operator issues an emergency stop, redirection, or prompt clarification.
- A long-running background command exceeds its execution deadline.

The following sections define the exact operating mechanics and low-level system behaviors across operating systems.

### 4.1 Standard Input (`stdin`) Injection

Standard input injection is the most direct, non-destructive interruption mechanism for CLI coding harnesses:

```
┌─────────────────────────────────┐                 ┌─────────────────────────────────┐
│     Supervisor / Intercom       │                 │       Child Agent Process       │
│                                 │                 │  (Claude Code / Qoder / Open)   │
│  1. Detect Interruption Trigger │                 │                                 │
│  2. Format Control Sequence     │                 │                                 │
│  3. child.stdin.write(payload)  ├────────────────►│  Stdin Read Buffer Unblocks     │
│                                 │                 │  Agent Event Loop Processes     │
└─────────────────────────────────┘                 │  Interrupt Instruction          │
                                                    └─────────────────────────────────┘
```

#### Operating Protocol
1. **Process Wrapping**: The supervisor spawns the child harness with `stdio: ['pipe', 'pipe', 'pipe']`.
2. **Preemption Sequence**: To cancel the current turn without killing the process:
   - For interactive sessions: The supervisor writes `\x03` (ASCII End-of-Text / Ctrl+C equivalent) into `child.stdin`.
   - Followed by a newline-terminated steering prompt:  
     `"[INTERRUPT]: User commanded pivot: Halt current edits and report status.\n"`
3. **Latency**: Sub-5ms ($<5\text{ms}$) direct pipe buffer transit.
4. **Windows vs. POSIX Details**:
   - **POSIX**: Piped stdin interacts with `termios` line disciplines and signals cleanly.
   - **Windows**: When standard streams are redirected as pipes, Node.js and Win32 set `isTTY = false`. CLI tools designed for interactive terminals may disable prompts or exit unless executed in headless non-interactive mode (`-p` / `--auto`).
   - **ConPTY Emulation**: When wrapping interactive tools on Windows, `intercom-global` utilizes `node-pty` to spawn an underlying Windows Pseudo Console (`ConPTY`), preserving full TTY emulation and signal propagation.

#### 4.1.1 Stdin Interruption Mode Disambiguation: Interactive PTY vs. Headless JSON-RPC Pipes
A critical engineering distinction must be enforced between interactive terminal streams and headless structured protocol pipes:

1. **Interactive PTY / Terminal Sessions (CLI Harnesses)**:
   - *Target Runtimes*: Claude Code (interactive mode), Alibaba Qoder (TUI mode), OpenCode terminal.
   - *Interruption Mechanism*: Inject `\x03` (ASCII byte `0x03` / Ctrl+C) directly into the terminal or ConPTY input stream.
   - *Behavior*: ConPTY/termios translates `\x03` into a keyboard interrupt event, causing the CLI shell to abort the ongoing generation turn and return to the prompt listener, where steering instructions are immediately received.

2. **Headless Stdio / JSON-RPC Structured Pipes (MCP, Cursor, VS Code / Cline)**:
   - *Target Runtimes*: Model Context Protocol (`intercom-mcp`), Cursor IDE extension agents, Cline / Roo Code extension hosts.
   - *CRITICAL INVARIANT*: **DO NOT inject raw `\x03` into headless stdio or JSON-RPC pipes.**
   - *Failure Mode*: JSON-RPC transports over stdio parse incoming byte streams strictly as JSON envelopes (`{"jsonrpc": "2.0", ...}`) or Content-Length framed packets. Injecting raw byte `0x03` corrupts the parser state, triggering an immediate `SyntaxError: Unexpected token '\x03' in JSON at position 0` and fatally crashing the JSON-RPC channel with error code -32700.
   - *Mandatory Mechanism for Headless Stdio*:
     - **In-Band JSON-RPC Cancellation**: Send a standardized cancellation notification over the stdio stream:
       ```json
       {
         "jsonrpc": "2.0",
         "method": "$/cancelRequest",
         "params": { "id": "<activeRequestId>" }
       }
       ```
     - **Out-of-Band HTTP/WS Daemon Abort**: If the JSON-RPC channel is congested by large payload transfers, issue an out-of-band abort request to the local daemon:
       ```http
       POST {{DAEMON_URL}}/api/interrupt
       Content-Type: application/json

       { "agent": "cursor", "action": "CANCEL_ACTIVE_REQUEST", "reason": "User redirection" }
       ```
       The target extension's internal listener triggers its native `AbortController.abort()`, cleanly canceling tool execution without stream framing corruption.

### 4.2 Operating System Signals (Windows Win32 Reality vs. POSIX)

A widespread, fatal misconception in multi-agent tool development is assuming POSIX signal semantics exist on Windows.

#### The POSIX Reality
In POSIX environments (Linux, macOS, BSD):
- Signals (`SIGINT`, `SIGTERM`, `SIGUSR1`, `SIGUSR2`, `SIGHUP`) are delivered asynchronously via OS interrupts.
- User-space applications install signal handlers (`process.on('SIGUSR1', handler)`).
- The process remains alive while executing the handler code.

#### The Windows (Win32) Reality
- **`SIGUSR1` and `SIGUSR2` DO NOT EXIST on Windows.**
- The Windows kernel does not have a general-purpose asynchronous signaling mechanism equivalent to POSIX signals.
- In Node.js on Windows:
  ```javascript
  // FATAL ON WINDOWS:
  process.kill(targetPid, 'SIGUSR1');
  // Throws: Error: kill EINVAL or triggers immediate TerminateProcess!
  ```
- Node.js emulates `SIGINT` and `SIGTERM` on Windows using the Win32 API `TerminateProcess(hProcess, exitCode)`. This causes **instantaneous process destruction** with zero cleanup, corrupting open file handles and leaving dirty locks.
- **Console Control Events**: The only native Win32 equivalent to terminal signals is `GenerateConsoleCtrlEvent(CTRL_C_EVENT, processGroupId)`. This requires the target process to share a console process group.

#### Invariant Rule for `intercom-global`
> **Never rely on POSIX signals for non-destructive inter-process communication on Windows.**  
> All interruptions on Windows must use **stdin preemption**, **local loopback sockets**, **named pipes**, or **reactive file-mesh flags**.

### 4.3 HTTP Server-Sent Events (SSE) & WebSockets

For agent architectures running embedded servers (OpenCode, VS Code extension hosts, IDE webviews):
- **Full-Duplex WebSockets**:
  ```javascript
  // Outgoing interrupt payload
  socket.send(JSON.stringify({
    type: "interrupt",
    priority: "CRITICAL",
    payload: {
      action: "ABORT_TOOL_EXECUTION",
      reason: "User requested immediate redirection",
      redirectPrompt: "Re-run verification with verbose logging."
    }
  }));
  ```
- **AbortController Unwinding**:
  The receiving agent links the WebSocket interrupt event to its internal `AbortController`:
  ```javascript
  intercomSocket.on('message', (data) => {
    const envelope = JSON.parse(data);
    if (envelope.type === 'interrupt') {
      currentTurnAbortController.abort(envelope.payload.reason);
    }
  });
  ```
  Pending network requests, LLM streaming calls, and tool executions unwind gracefully with `AbortError`, returning the agent to an interactive standby state.

### 4.4 Windows Named Pipes vs. Unix Domain Sockets

For high-security, local-only IPC that bypasses network stack firewalls:
- **Windows Named Pipe Path**: `\\.\pipe\intercom-<agentName>`
- **Unix Domain Socket Path**: `/tmp/intercom-<agentName>.sock` (or `$XDG_RUNTIME_DIR/intercom-<agentName>.sock`)
- **Transport Abstraction**: Both transports are unified under Node.js `net.createServer()` and `net.connect()`:
  ```javascript
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\intercom-${agentName}`
    : `/tmp/intercom-${agentName}.sock`;

  const server = net.createServer((socket) => {
    // Length-prefixed framing prevents message fragmentation
    socket.pipe(new MessageDecoder()).on('envelope', handleEnvelope);
  });
  server.listen(pipePath);
  ```
- **Performance**: $<2\text{ms}$ latency, zero network port conflicts, and kernel-enforced Windows ACL security.

### 4.5 Discrete Atomic File-Mesh (Zero-Loss Guarantee)

The file-mesh ensures guaranteed delivery when processes are offline:

```
[Sender]
   │
   ├─► 1. Generate UUIDv4: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
   ├─► 2. Generate Timestamp: 1730000000000
   ├─► 3. Serialize Envelope to JSON
   ├─► 4. Write to: 'mesh/inbox/<recipient>/.tmp_a1b2c3d4.tmp'
   │       └── Flush to disk (fs.flushSync)
   ├─► 5. Atomic Rename:
   │       'mesh/inbox/<recipient>/.tmp_a1b2c3d4.tmp'
   │       ──► 'mesh/inbox/<recipient>/1730000000000_a1b2c3d4.json'
   │
   └─► 6. Complete (Return Delivery Confirmation)

[Receiver]
   │
   ├─► 1. Watch directory 'mesh/inbox/<recipient>/' (chokidar / fs.watch)
   ├─► 2. Filter for files matching /^\d+_[a-f0-9\-]+\.json$/
   ├─► 3. Sort chronologically by timestamp
   ├─► 4. For each file:
   │       ├── Acquire in-memory deduplication lock
   │       ├── Read and parse JSON
   │       ├── Execute message payload
   │       └── Move to 'mesh/archive/' or unlink (fs.unlinkSync)
   └─► 5. Acknowledge delivery
```

#### Windows NTFS Safe Retries (Dual-Side Resilience)
Windows NTFS file locks created by background file scanners, antivirus engines (e.g., Windows Defender), or IDE search indexers can momentarily block file mutations. `intercom-global` implements dual-sided retry protection:

1. **Sender-Side Write/Rename Retry Loop**:
   - `fs.renameSync(tmpPath, finalPath)` is wrapped in an exponential backoff retry loop:
   - Schedule: **5 attempts** with delays of **20ms, 40ms, 80ms, 160ms, 320ms (+ randomized jitter 0–15ms)**.
   - If `EBUSY` or `EPERM` is thrown, the sender yields and retries. Because destination filenames are globally unique (`<timestamp>_<uuid>.json`), write collisions are mathematically impossible.

2. **Receiver-Side Acknowledgment & Archival Retry Loop**:
   - When a receiver acknowledges a message by deleting it (`fs.unlinkSync`) or moving it to the archive directory (`fs.renameSync(inboxPath, archivePath)`), open handles by indexers can also trigger `EBUSY` or `EPERM`.
   - The consumer executes the identical **5-attempt exponential backoff schedule** (20ms, 40ms, 80ms, 160ms, 320ms + jitter).
   - If all 5 attempts fail due to an enduring external lock, the message remains marked as in-flight in memory and is retried on the next scan cycle without crashing the consumer.

### 4.6 Grounded Real-World Harness Interfacing & Protocol Schemas

To achieve deterministic inter-process communication with external terminal harnesses without human intervention, `intercom-global` and `ex-delegate-mcp` enforce precise protocol adapters across all supported CLI engines:

#### 4.6.1 Anthropic Claude Code CLI Adapter
- **Binary**: `claude` (Node.js packaging)
- **Headless Non-Interactive Invocation**:
  ```bash
  claude -p "<prompt>" --dangerously-skip-permissions
  ```
- **Stdin Stream Composition**:
  Claude Code detects when standard input is piped (`isTTY === false` on stdin). Piped data is prepended to the user instruction context:
  ```bash
  cat bug-trace.log | claude -p "Diagnose root cause and modify source" --dangerously-skip-permissions
  ```
- **Session Continuity Protocol**:
  - `claude -c -p "<prompt>"`: Appends instruction to the active working directory session.
  - `claude -r "<session-uuid>" -p "<prompt>"`: Appends instruction to an explicit named session.
- **Interruption Vector**:
  In interactive terminal mode, `intercom-global` injects `\x03` via ConPTY. In headless `-p` mode, subagent supervisor aborts by closing `childProcess.stdin` or sending `SIGINT` (Win32 `GenerateConsoleCtrlEvent`).

#### 4.6.2 Roo-Code & Cline (VS Code Extension Host Bridge)
- **Host Process**: VS Code Extension Host (Node.js) <-> Webview Panel (Chromium Sandbox).
- **IPC Protocol Envelope (`WebviewMessage` / `ExtensionMessage`)**:
  ```typescript
  // Webview -> Extension Host
  interface WebviewMessage {
    type: "newTask" | "askResponse" | "clearTask" | "loadTaskWithId" | "cancelTask";
    text?: string;
    askResponse?: "yesButtonClicked" | "noButtonClicked" | "messageResponse";
    values?: Record<string, unknown>;
  }

  // Extension Host -> Webview
  interface ExtensionMessage {
    type: "state" | "say" | "action";
    state?: ExtensionState;
    say?: "api_req_started" | "text" | "tool" | "command";
    text?: string;
  }
  ```
- **Disk Persistence Format**:
  Stored in `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\tasks\<taskId>\`:
  - `ui_messages.json`: Array of `{ ts, type, say, text, partial }` for visual rendering.
  - `api_conversation_history.json`: Array of `{ role, content }` conforming to model provider schemas.
  - `task.json`: Metadata envelope `{ id, prompt, createdAt, tokensIn, tokensOut, cost }`.
- **Intercom Integration Point**:
  External agents dispatch tasks into Roo-Code using VS Code commands:
  ```javascript
  vscode.commands.executeCommand("roo-cline.newTask", "Task specification from Intercom");
  ```

#### 4.6.3 OpenCode CLI & REST Server Protocol (`{{DEFAULT_HARNESS}}`)
- **Daemon Mode**:
  `opencode serve --port 4096 --hostname 127.0.0.1`
- **Session API Contract**:
  - `POST /session`: Creates a new session `{ id: "{{SAMPLE_SESSION_ID}}" }`.
  - `POST /session/:id/prompt_async`: Queues a prompt non-blockingly and returns HTTP 204 No Content.
  - `GET /session/:id/message`: Streams Server-Sent Events (SSE) of model tokens and tool invocations.
- **CLI Batch Syntax**:
  ```bash
  opencode run --auto --model "{{DEFAULT_MODEL}}" --print-logs "<prompt>"
  ```
- **Session Resumption**:
  - `opencode run -c "<prompt>"`: Resumes the most recent session.
  - `opencode run --session "<id>" "<prompt>"`: Resumes an explicit session ID.

#### 4.6.4 Alibaba Qoder Engine Adapter (Zero-Qoder Restricted)
- **Zero-Qoder Invariant**: `qoder` is barred from automatic routing and default fallback chains (`{{FALLBACK_CHAIN}}`). Explicit invocations must restrict `-m` strictly to verified free-tier models (`{{QODER_ALLOWED_MODELS}}`).
- **Binary**: `qoder` (Go/C++ Native)
- **Headless Non-Interactive Invocation (Explicit Free-Tier Only)**:
  ```bash
  qoder -p -m "{{DEFAULT_QODER_FREE_MODEL}}" --dangerously-skip-permissions -o json "<prompt>"
  ```
- **Git Worktree Isolation**:
  ```bash
  qoder --worktree "worker-task-1" -m "{{DEFAULT_QODER_FREE_MODEL}}" -p "Refactor module and verify tests"
  ```
- **Settings Injection Schema (`--settings <path>`)**:
  ```json
  {
    "reasoningEffort": "high",
    "thinking": {
      "mode": "enabled",
      "budget": 4096
    },
    "model": {
      "preferences": {
        "{{DEFAULT_QODER_FREE_MODEL}}": {
          "reasoning": { "effort": "high" }
        }
      }
    }
  }
  ```
- **Session Continuation**:
  - `qoder -c -p "<prompt>"`: Continues latest session.
  - `qoder -r "<id>" -p "<prompt>"`: Resumes explicit session ID.

#### 4.6.5 Google Jules Cloud Delegation Protocol
- **Binary**: `jules` (Google Cloud CLI tool)
- **Cloud Task Dispatch**:
  ```bash
  jules new "<5-pillar-prompt>"
  ```
- **Target Constraints**:
  - 1 to 3 files maximum.
  - Heavy modifications ($\ge 100$ LOC) or comprehensive test suites.
- **5-Pillar Template Structure**:
  ```text
  [PILLAR 1: GOAL]
  <Single-sentence objective>

  [PILLAR 2: TARGET FILE]
  <Exact workspace path>

  [PILLAR 3: CONTEXT & DEFECT]
  <Problem statement, line numbers, error logs>

  [PILLAR 4: INVARIANT CONSTRAINTS]
  <WCAG AA 4.5:1, 8px grid, 6-key auth cleanup, zero inline styles>

  [PILLAR 5: VERIFICATION COMMAND]
  <npm test command and acceptance criteria>
  ```
- **Quota & Fallback**:
  - 15 concurrent sessions / 100 daily dispatches tracked in `~/.intercom-global/jules-ledger.json`.
  - Fallback to local worker subagents on throttling.

---

## 5. Multi-Agent Delegation Topologies

Modern multi-agent architectures employ distinct delegation topologies. `intercom-global` maps and bridges these patterns into a unified communication substrate:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   MULTI-AGENT DELEGATION TOPOLOGIES                                    │
├───────────────────────────────┬───────────────────────────────────┬────────────────────────────────────┤
│ Framework / Paradigm          │ Structural Topology               │ Interruption & Delegation Semantics│
├───────────────────────────────┼───────────────────────────────────┼────────────────────────────────────┤
│ 1. AutoGen (ConversableAgent) │ Star Topology / Group Chat        │ Round-robin conversational turns.  │
│                               │ Supervisor coordinates workers.   │ Interruption injected via human    │
│                               │ Peer-to-peer replies.             │ input mode between speaker turns.  │
├───────────────────────────────┼───────────────────────────────────┼────────────────────────────────────┤
│ 2. CrewAI (Hierarchical DAG)  │ Hierarchical Tree Topology        │ Manager agent assigns structured   │
│                               │ Top-down delegation to specialist │ tasks. Task outputs bubble up to   │
│                               │ roles (Researcher, Writer).       │ parent. Synchronous handoff gates. │
├───────────────────────────────┼───────────────────────────────────┼────────────────────────────────────┤
│ 3. LangGraph (FSM Graph)      │ Cyclic / Acyclic StateGraph       │ Explicit nodes and edges. Interrupt│
│                               │ Shared state memory passed across │ before/after nodes allow pausing   │
│                               │ nodes with persistent checkpoint. │ for human validation or steering.  │
├───────────────────────────────┼───────────────────────────────────┼────────────────────────────────────┤
│ 4. ACP / A2A Protocol         │ Decentralized Peer-to-Peer Mesh   │ Agent State Cards discovered via   │
│                               │ Flat network of autonomous nodes  │ `/.well-known/agent.json`. HTTP/   │
│                               │ communicating via JSON-RPC.       │ JSON task dispatches & handshakes. │
├───────────────────────────────┼───────────────────────────────────┼────────────────────────────────────┤
│ 5. Model Context Protocol     │ Client-Server Protocol            │ Host/Client invokes tools/resources│
│    (MCP)                      │ Standardized JSON-RPC over stdio  │ on MCP servers. Notifications and  │
│                               │ or Server-Sent Events (SSE).      │ progress tracking over RPC stream. │
└───────────────────────────────┴───────────────────────────────────┴────────────────────────────────────┘
```

### 5.1 Parent-to-Child Task Dispatch Pattern

When a supervisor (such as the Teamwork Orchestrator) delegates a task to a worker:
1. **Envelope Creation**:
   - `sender`: `"orchestrator"`
   - `recipient`: `"worker_m1"`
   - `type`: `"task_dispatch"`
   - `correlationId`: `<taskUuid>` (tracks entire delegation tree)
   - `parentId`: `<orchestratorSessionUuid>`
   - `priority`: `"NORMAL"` | `"HIGH"`
   - `payload`: Contains structured assignment, target file paths, constraints, and acceptance criteria.
2. **Dispatch**: Transmitted over Fast-Path if available; journaled to Safe-Path.
3. **Execution**: Worker ingests task, creates its local working state (`progress.md`, `BRIEFING.md`), and executes.

### 5.2 Child-to-Parent Response & Escalation Pattern

When the worker completes or requires architectural guidance:
1. **Result Envelope**:
   - `sender`: `"worker_m1"`
   - `recipient`: `"orchestrator"`
   - `type`: `"task_response"`
   - `correlationId`: `<taskUuid>` (matches incoming task)
   - `payload`: Contains completion status (`SUCCESS` | `FAILED`), handoff report path (`handoff.md`), modified file list, and verification commands executed.
2. **Reactive Wakeup**: In Antigravity and Cursor, the arrival of the response triggers a reactive tool wake or supervisor notification without active polling.

---

## 6. Google Jules Cloud Delegation Integration Architecture

To conserve local developer machine resources, protect subagent context windows, and offload massive refactoring jobs, `{{PROJECT_NAME}}` integrates **Google Jules** (powered by `{{DEFAULT_JULES_MODEL}}` on Google Cloud VMs).

```
                              Task Analysis & Classification
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼                                             ▼
       Matches Jules Heavy Criteria?                  Standard Local Task?
                     │                                             │
      ┌──────────────┴──────────────┐                              │
     YES                            NO                             │
      │                              │                             │
Check Pre-Flight Quota               │                             │
(jules remote list --session)        │                             │
      │                              │                             │
  ┌───┴───┐                          │                             │
PASS     FAIL (Throttled)            │                             │
  │       │                          │                             │
  │       └──────────────────────────┼─────────────────────────────┘
  │                                  │
  ▼                                  ▼
Format 5-Pillar Jules Prompt   Dispatch to Local Worker Subagent
Dispatch via CLI:              (e.g., worker_m2, worker_m3)
`jules new "<prompt>"`
```

### 6.1 Single-File Heavy-Lift Routing Criteria

Google Jules operates in an asynchronous cloud VM environment with a provisioning and compilation turnaround time of **10 to 30 minutes**. Offloading trivial or multi-file exploratory tasks to Jules introduces massive latency overhead.

Therefore, tasks are routed to Google Jules **ONLY** when meeting all of the following criteria:
1. **Strict File Boundary ($\le 3$ Files)**:
   - **Target Span**: Must involve at most **1 to 3 files** (ideally 1 single file).
   - **Multi-File Prohibition**: Tasks spanning 4+ files must **NEVER** be delegated directly to Jules. The multi-agent orchestrator must decompose multi-file tasks into discrete single-file dispatches.
2. **Task Intensity**:
   - Overhauls modifying $\ge 100$ lines of code, or
   - Complex AST restructuring / algorithmic rewrites, or
   - Generating comprehensive unit and integration test suites ($>30$ test cases).

### 6.2 5-Pillar Parameterized Prompt Template with Fixing Values

Every dispatch to Google Jules must be constructed using the **5-Pillar Format**, incorporating exact fixing values and invariant constraints:

```text
[PILLAR 1: GOAL]
<Clear, unambiguous single-sentence objective specifying the exact feature or fix to implement>

[PILLAR 2: TARGET FILE]
<Exact workspace-relative file path, e.g., src/core/mesh.js>

[PILLAR 3: CONTEXT & DEFECT]
<Comprehensive problem statement, reproduction command, exact line numbers, and root-cause analysis>
Observed Defect:
<Verbatim error message or race condition trace>
Root Cause:
<Technical explanation of the flaw>

[PILLAR 4: INVARIANT CONSTRAINTS (FIXING VALUES)]
All implementations must strictly adhere to:
1. Zero inline styles / strict 8px grid spatial layout.
2. WCAG AA 4.5:1 minimum contrast in both light and dark themes.
3. Synchronized 6-key auth token cleanup on any 401 Unauthorized response:
   - localStorage.removeItem('auth_token')
   - localStorage.removeItem('session_user')
   - localStorage.removeItem('customer_session')
   - localStorage.removeItem('customer_session_last_activity')
   - localStorage.removeItem('customer_session_expires')
   - localStorage.removeItem('iot_workspace_authenticated')
4. Zero-loss discrete atomic file operations (never overwrite shared monolithic JSON files).
5. No placeholder implementations, no fake mocks, real genuine logic only.

[PILLAR 5: VERIFICATION COMMAND]
<Exact command to execute and verify the fix, e.g., npm test -- test/mesh.test.js>
Acceptance Criteria:
- Test suite exits with code 0 (100% passing).
- Zero unhandled exceptions or lint warnings.
```

### 6.3 Concurrency & Quota Management

Google Jules imposes platform-level usage limits:
- **Maximum Concurrent Sessions**: **15 active sessions**.
- **Daily Quota Cap**: **100 dispatches per 24-hour rolling window**.

#### 6.3.1 Persistent Quota Accounting Ledger (`~/.intercom-global/jules-ledger.json`)
Because multiple autonomous agents operate concurrently across different IDE processes and CLI shells, in-memory counters cannot track daily dispatch quotas across process lifecycles. `intercom-global` enforces daily quota governance via a persistent atomic JSON ledger:
- **Location**: `~/.intercom-global/jules-ledger.json` (protected by directory CAS advisory lock `~/.intercom-global/locks/jules-ledger.lock`).
- **Ledger Schema**:
  ```json
  {
    "version": "1.0.0",
    "rollingWindowMs": 86400000,
    "dailyCap": 100,
    "dispatches": [
      {
        "dispatchId": "{{SAMPLE_TASK_ID}}",
        "sessionId": "{{SAMPLE_SESSION_ID}}",
        "timestamp": "{{CURRENT_ISO_TIMESTAMP}}",
        "epochMs": 1729771200000,
        "targetFile": "src/core/mesh.js",
        "status": "COMPLETED"
      }
    ]
  }
  ```
- **Ledger Verification Algorithm**:
  1. Acquire `jules-ledger.lock` with 3s TTL.
  2. Read `jules-ledger.json` (or initialize if not present).
  3. Prune historical entries older than the rolling window: `now - entry.epochMs > 86400000` (24 hours).
  4. Count valid entries in the remaining window:
     - If `activeEntries.length >= 100`, daily quota is exhausted (`quotaExhausted = true`).
  5. Upon a successful `jules new` dispatch, append the record with current epoch timestamp and write atomically via safe rename.
  6. Release `jules-ledger.lock`.

#### 6.3.2 Automated Gating Protocol
1. Before issuing `jules new`, the delegator executes:
   ```bash
   jules remote list --session --output json
   ```
2. The JSON output is parsed to compute active cloud session count.
3. The delegator reads `~/.intercom-global/jules-ledger.json` to verify rolling 24-hour quota.
4. **Throttling Action**:
   - If active sessions $\ge 14$ (buffer of 1) OR rolling daily quota $\ge 100$:
   - The delegator immediately flags `fallbackRequired = true`.
   - The task is routed seamlessly to a local worker subagent (`worker_m2`, `worker_m3`) without stalling or blocking.

### 6.4 Automatic Graceful Local Fallback

If the Jules CLI is not installed, unauthenticated (`jules login` required), times out, or encounters cloud VM provisioning failures:
- The delegator intercepts the failure within $\le 500\text{ms}$.
- Converts the 5-pillar prompt into a standard Teamwork `DISPATCH.md`.
- Spawns or assigns a local worker subagent with identical task criteria.
- Logs the fallback event in the orchestrator progress journal.

#### 6.4.1 Circular Fallback Anti-Loop Invariant
When a task is demoted from Google Jules to a local worker subagent, a catastrophic failure mode in multi-agent routing is the "circular ping-pong delegation loop":
- The orchestrator classifies Task X as heavy $\rightarrow$ routes to Jules $\rightarrow$ Jules is throttled $\rightarrow$ falls back to Local Worker.
- Local Worker analyzes Task X $\rightarrow$ classifies it as heavy (>100 LOC) $\rightarrow$ attempts to re-delegate Task X back to Jules $\rightarrow$ throttled $\rightarrow$ recurses infinitely.

To eliminate circular delegation, the framework mandates the **Anti-Loop Invariant**:
1. Every fallback task envelope dispatched to a local worker MUST inject explicit recursion-prevention flags:
   ```json
   {
     "payload": {
       "instruction": "...",
       "targetFiles": ["src/core/mesh.js"],
       "fallbackOrigin": "jules",
       "disallowJulesReDelegation": true
     }
   }
   ```
2. **Enforcement in Task Classifier**:
   The task classifier and router must explicitly check:
   ```javascript
   function canDelegateToJules(task) {
     if (task.payload?.disallowJulesReDelegation === true || task.payload?.fallbackOrigin === 'jules') {
       return { eligible: false, reason: 'Task was already routed from Jules fallback; circular delegation prohibited' };
     }
     // Proceed with LOC and file boundary checks...
   }
   ```
3. Local workers receiving a task with `disallowJulesReDelegation: true` must execute the task directly using surgical local tools or report back to the orchestrator, never re-invoking Jules.

---

## 7. Governance Invariants & Operational Discipline

To maintain high reasoning quality and prevent resource degradation, `intercom-global` enforces two inviolable governance invariants:

### 7.1 Zero-Kill Protocol (Non-Destructive Agent Lifecycle)

```
                       Agent Execution Anomaly Detected
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
      ❌ FORBIDDEN ACTION                     ✅ MANDATORY PROTOCOL
      Kill / Terminate Agent Process          Preserve Session & Steer
      `process.kill(pid, 'SIGKILL')`          1. Send Steering Message
      `manage_task(Action="kill")`            2. Stdin Interrupt (`\x03`)
                                              3. Provide Remediation Guidance
                                              4. Resume Standby Session
```

#### Invariant Rules
1. **Never Kill Active Agents**: Coding agents, worker subagents, and explorer agents must **NEVER** be arbitrarily terminated, killed, or pruned when encountering errors, test failures, or pauses.
2. **Resume & Steer**:
   - If an agent is stuck in an error loop, the orchestrator sends an interruption message containing the exact error trace and guidance.
   - If an agent enters an idle standby state, it is re-engaged with a new task dispatch using its existing session context.
3. **Graceful Teardown Exception**: The only permitted termination is clean, graceful teardown initiated by the orchestrator at the explicit conclusion of the entire project milestone after all handoffs are verified.

### 7.2 Bounded Subagent Reuse Governance (3 to 10 Iterations)

Continuous multi-agent reasoning creates context accumulation. If an agent is reused indefinitely, accumulated conversational history degrades reasoning performance (context fatigue). Conversely, spawning a brand new agent for every single minor line change causes massive memory clutter and process sprawl.

#### Bounded Reuse Schedule
- **Small Tasks (Bug fixes, doc updates, single-file patches)**:
  - Worker subagents can be reused **up to 10 times**.
- **Big Tasks (Large refactoring, full module builds, complex test suites)**:
  - Worker subagents can be reused **up to 3 times**.
- **Persistent Guiding Subagents (Coordinator, Orchestrator, Architect)**:
  - **NEVER pruned or replaced**. They persist throughout the entire lifecycle to maintain global architectural continuity.
- **Maximum Team Concurrency**:
  - The total active concurrent subagent team is strictly capped at **10 agents maximum**.

---

## 8. Security Architecture & Threat Model

Operating cross-IDE communications on local developer workstations requires stringent sandboxing and validation to prevent remote code execution (RCE) and directory traversal attacks.

### 8.1 Path-Traversal & Directory Containment Defense (Strict Rejection)

Mutating sanitization (such as `userInput.replace(/\.\./g, '')`) is inherently unsafe because attackers can construct nested bypasses (e.g. `....//` collapses into `../`). `intercom-global` enforces **Strict Rejection** where any input containing traversal sequences or encoded variants is immediately rejected before touching the filesystem:

```javascript
// Strict rejection tokens: parent directory traversal, slashes, and URL-encoded variants
const PATH_TRAVERSAL_REGEX = /(\.\.|\/|\\|%2e%2e|%2f|%5c)/i;

function resolveSafePath(baseDir, userInput) {
  if (typeof userInput !== 'string' || userInput.trim() === '') {
    throw new SecurityError('Invalid input: path component must be a non-empty string');
  }

  // 1. Strict rejection: Disallow any traversal token or slash in single-segment identifiers
  if (PATH_TRAVERSAL_REGEX.test(userInput)) {
    throw new SecurityError(`Path traversal attack rejected: "${userInput}" contains illegal traversal tokens`);
  }

  // 2. Resolve to absolute path
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, userInput);

  // 3. Jail check: target MUST be directly contained inside base directory
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new SecurityError(`Directory jail violation: "${userInput}" resolves outside "${baseDir}"`);
  }

  return resolvedTarget;
}
```

### 8.2 Windows DOS Device & Special Name Protection (Extended Sanitization)

Windows retains legacy MS-DOS device names from MS-DOS 1.0/2.0 that, when opened as file paths in Win32, freeze the calling thread, block the filesystem driver, or trigger blue screens:
- **Primary Reserved Names**: `CON`, `PRN`, `AUX`, `NUL`, `COM1` through `COM9`, `LPT1` through `LPT9`.
- **Extended Reserved Win32 Devices**: `CONIN$` (console keyboard input handle), `CONOUT$` (console screen buffer handle), and `CLOCK$` (system clock device driver). Opening files named `CONIN$` or `CONOUT$` can lock Windows I/O queues indefinitely.
- **NTFS Alternate Data Streams (ADS)**: Filenames containing colons (e.g., `agent:secret.json`) allow hidden data stream injection or extension bypass.

#### Hardened Sanitization Protocol
All agent names, channel names, and file identifiers are strictly validated against the extended regex suite:

```javascript
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_\-]+$/;
const DOS_DEVICE_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$|CLOCK\$)(\..*)?$/i;

function validateAgentName(name) {
  if (!SAFE_IDENTIFIER_REGEX.test(name)) {
    throw new SecurityError(
      `Invalid agent identifier: "${name}". Only alphanumeric, hyphen, and underscore characters are allowed.`
    );
  }
  if (DOS_DEVICE_REGEX.test(name)) {
    throw new SecurityError(
      `Reserved Windows DOS/Win32 device name rejected: "${name}". Extended device handles (CONIN$, CONOUT$, CLOCK$) are prohibited.`
    );
  }
}
```

### 8.3 Loopback Network Isolation

1. **Localhost Binding**: All HTTP daemons, WebSockets, and REST services bind strictly to `127.0.0.1` (IPv4 loopback) and `::1` (IPv6 loopback). Binding to `0.0.0.0` is strictly forbidden.
2. **CORS Hardening**: Cross-Origin Resource Sharing is locked down to local origin ports (`http://localhost:*`, `http://127.0.0.1:*`, `vscode-webview://*`). External origins receive HTTP 403 Forbidden.
3. **Optional Secret Header**: Cross-process HTTP requests validate an internal session token stored in `~/.intercom-global/.secret`.

---

## 9. Standardized Data Specifications & Schemas

### 9.1 Standardized `MessageEnvelope` Schema

Every message transmitted over Fast-Path or Safe-Path adheres to the following JSON schema:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "MessageEnvelope",
  "type": "object",
  "required": ["id", "timestamp", "sender", "recipient", "type", "priority", "payload"],
  "properties": {
    "id": {
      "type": "string",
      "format": "uuid",
      "description": "Unique UUIDv4 identifier for this message"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "ISO-8601 creation timestamp"
    },
    "epochMs": {
      "type": "integer",
      "description": "Epoch millisecond timestamp for high-performance sorting"
    },
    "sender": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9_\\-]+$",
      "description": "Identifier of the sending agent or user"
    },
    "recipient": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9_\\-]+$",
      "description": "Identifier of the target receiving agent"
    },
    "type": {
      "type": "string",
      "enum": ["task_dispatch", "task_response", "interrupt", "heartbeat", "ack"],
      "description": "Semantic message classification"
    },
    "priority": {
      "type": "string",
      "enum": ["LOW", "NORMAL", "HIGH", "CRITICAL"],
      "default": "NORMAL",
      "description": "Processing priority"
    },
    "correlationId": {
      "type": "string",
      "description": "UUID linking a task dispatch to its eventual response"
    },
    "parentId": {
      "type": "string",
      "description": "Session UUID of the delegating supervisor"
    },
    "payload": {
      "type": "object",
      "description": "Arbitrary structured payload content",
      "properties": {
        "instruction": { "type": "string" },
        "targetFiles": { "type": "array", "items": { "type": "string" } },
        "status": { "type": "string", "enum": ["SUCCESS", "FAILED", "IN_PROGRESS", "ABORTED"] },
        "reportPath": { "type": "string" }
      }
    },
    "metadata": {
      "type": "object",
      "description": "Transport telemetry (hop count, source IDE, PID)"
    }
  }
}
```

### 9.2 Standardized Agent State Card (`registry/<agent>.json`)

The Agent State Card enables dynamic service discovery and capabilities matching across IDEs:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AgentStateCard",
  "type": "object",
  "required": ["agentId", "name", "ide", "role", "pid", "status", "capabilities", "lastHeartbeat"],
  "properties": {
    "agentId": { "type": "string", "format": "uuid" },
    "name": { "type": "string", "pattern": "^[a-zA-Z0-9_\\-]+$" },
    "ide": { 
      "type": "string", 
      "enum": ["antigravity", "cursor", "windsurf", "vscode", "claude_code", "opencode", "qoder", "mcode", "jules", "unknown"] 
    },
    "role": { 
      "type": "string", 
      "enum": ["orchestrator", "coordinator", "architect", "worker", "explorer", "reviewer", "critic", "auditor", "specialist"] 
    },
    "pid": { "type": "integer" },
    "status": { "type": "string", "enum": ["IDLE", "BUSY", "OFFLINE"] },
    "capabilities": {
      "type": "array",
      "items": { "type": "string" },
      "example": ["ast_inspection", "refactoring", "test_execution", "jules_cloud_vm"]
    },
    "transport": {
      "type": "object",
      "properties": {
        "daemonUrl": { "type": "string" },
        "pipeName": { "type": "string" },
        "inboxDir": { "type": "string" }
      }
    },
    "lastHeartbeat": { "type": "string", "format": "date-time" },
    "reuseCount": { "type": "integer", "default": 0 }
  }
}
```

---

## 10. CLI Command Suite & Developer Workflows

The `{{PROJECT_NAME}}` CLI (`{{CLI_COMMAND}}`, v{{PROJECT_VERSION}}) provides `{{CLI_COMMANDS_COUNT}}` commands as a unified control interface for developers and automated CI scripts:

```bash
# 1. Start the high-performance local daemon
{{CLI_COMMAND}} daemon start --port {{DAEMON_PORT}}

# 2. Dispatch a task to an agent (automatic Fast-Path or Safe-Path routing)
{{CLI_COMMAND}} send worker_m1 "Implement zero-loss discrete mesh transport in src/core/mesh.js" \
  --from orchestrator --type task_dispatch --priority HIGH --correlation-id {{SAMPLE_TASK_ID}}

# 3. Interactively watch and stream messages for the current agent
{{CLI_COMMAND}} watch worker_m1

# 4. Issue a real-time preemption interrupt
{{CLI_COMMAND}} interrupt worker_m1 --reason "Halt edits, critical regression detected in build"

# 5. Launch Model Context Protocol (MCP) server ({{MCP_TOOLS_COUNT}} tools) for IDE integration
{{CLI_COMMAND}} mcp

# 6. Sync live purified model & harness registries
{{CLI_COMMAND}} sync --force

# 7. Dispatch a heavy single-file task to Google Jules ({{DEFAULT_JULES_MODEL}})
{{CLI_COMMAND}} jules dispatch --file src/core/mesh.js --summary "Implement CAS locking"

# 8. Run self-healing connectivity diagnostics
{{CLI_COMMAND}} doctor
```

### Diagnostics Output Example (`{{CLI_COMMAND}} doctor`)
```text
================================================================================
             INTERCOM GLOBAL MESH HEALTH & CONNECTIVITY DIAGNOSTICS
================================================================================
Timestamp: {{CURRENT_ISO_TIMESTAMP}}
Platform : win32 (x64) | Node.js {{NODE_VERSION}} (min {{NODE_MIN_VERSION}})

[DAEMON & NETWORK STATUS]
  Local HTTP Daemon (:{{DAEMON_PORT}})    : ONLINE ({{DAEMON_URL}})
  SSE Event Stream             : READY ({{DAEMON_URL}}/api/intercom/events)
  Windows Named Pipes          : ACTIVE (\\.\pipe\intercom-mesh)

[DISCRETE FILE-MESH STORAGE]
  Mesh Directory               : C:\Users\Suran\.intercom-global\mesh
  Registry Active Peers        : {{ACTIVE_PEERS_COUNT}} active peers ({{ACTIVE_PEERS_LIST}})
  Pending Tasks                : {{ACTIVE_TASKS_COUNT}} active / {{TOTAL_TASKS_COUNT}} total (sample: {{SAMPLE_TASK_ID}})
  Live Registry Cache          : {{LIVE_MODEL_COUNT}} purified models ({{TOP_FREE_MODELS_COUNT}} free, synced {{LAST_SYNCED_AT}})
  Active Harnesses             : {{ACTIVE_HARNESSES}} (Fallback: {{FALLBACK_CHAIN}})

[EXTERNAL CLOUD & HARNESS INTEGRATIONS]
  Google Jules ({{DEFAULT_JULES_MODEL}}) : {{ACTIVE_SESSIONS_COUNT}} / 15 active sessions (sample: {{SAMPLE_SESSION_ID}})
  OpenCode REST Bridge         : READY (http://127.0.0.1:4096, default model: {{DEFAULT_MODEL}})
  Claude Code Stdin Pipe       : READY (default model: {{DEFAULT_CLAUDE_MODEL}})

[SYSTEM INTEGRITY VERIFICATION]
  Zero-Kill Protocol Guard     : ENFORCED
  Zero-Qoder Credit Guard      : ENFORCED (Allowlist: {{QODER_ALLOWED_MODELS}})
  NTFS Safe-Rename Retries     : ENABLED (5 attempts, jitter backoff)
  Path Traversal Sandboxing    : SECURE (All paths locked to workspace)
================================================================================
Result: 100% HEALTHY - All communication channels operating within nominal parameters.
================================================================================
```

---

## 11. Implementation Verification & Acceptance Mapping

This architectural specification satisfies all requirements established in Milestone 1 and the project charter:

| Charter Requirement | Architectural Section | Implementation Mapping |
| :--- | :--- | :--- |
| **R1. Cross-IDE Ecosystem Research** | Section 3 (Matrix), Section 5 (Topologies) | 7-platform cross-IDE matrix, AutoGen/CrewAI/LangGraph/ACP/MCP topologies. |
| **R1. Interruption Patterns & Harness Schemas** | Section 4 (Interruption Mechanics & Section 4.6 Harness Protocols) | Detailed mechanics for stdin, Win32 vs POSIX signals, SSE/WS, Named Pipes, Claude Code, Roo/Cline, OpenCode, Qoder, and Jules. |
| **R2. Dual-Transport Rebuild** | Section 2 (System Overview) | Fast-Path HTTP/WS daemon paired with Safe-Path discrete atomic file-mesh. |
| **R2. Atomic Concurrency Guarantee** | Section 2.2, Section 4.5 | Immutable discrete message files (`<ts>_<uuid>.json`) eliminating race conditions. |
| **R3. Google Jules Cloud Delegation** | Section 6 (Jules Pipeline) | 5-pillar prompt template, single-file criteria, 15 concurrent / 100 daily gating, local fallback. |
| **R4. Governance Invariants** | Section 7 (Governance) | Zero-Kill protocol and bounded reuse schedule (3 to 10 cycles). |
| **Security & Path Sandboxing** | Section 8 (Security Architecture) | Directory traversal jail checks, Windows DOS device protection, loopback isolation. |

---

*End of Architecture Specification.*
