# 📡 Intercom Global (`@advance/intercom-global` v2.0.0)

**Universal Multi-Agent Communication Mesh** — send, broadcast, wake, watch, and coordinate AI agents (`opencode, claude, hermes, pi, jules, codex, mcode, cursor, windsurf, vscode, antigravity, qoder, custom`) across terminals, IDEs, and APIs in real time.

> **Version**: `2.0.0` · **Snapshot Date**: `2026-11-25` · **Last Live Sync**: `2026-11-25T09:50:04.306Z` (TTL: `15` min)  
> **Active Harnesses**: `opencode, claude, jules, codex, mcode, vscode` · **Default Model**: `opencode/beam-free` · **Active Peers**: `3` (`antigravity, claude, opencode`)

[![Node.js](https://img.shields.io/badge/Node.js->=18.0.0-brightgreen)](https://nodejs.org) [![Version](https://img.shields.io/badge/version-2.0.0-blue)](#) [![Tests](https://img.shields.io/badge/tests-288-brightgreen)](#) [![Prometheus](https://img.shields.io/badge/Prometheus-%2Fmetrics-orange)](http://127.0.0.1:4150/metrics) [![Architecture](https://img.shields.io/badge/architecture-Discrete%20NTFS%20Mesh-blue)](#) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## ✨ Features

| Feature | Description |
|---|---|
| **Discrete File-Mesh** | Atomic per-message envelopes (`mesh/inbox/<agent>/<ts>_<uuid>.json`) eliminating monolithic file write races |
| **Atomic NTFS CAS Locks** | Directory-based Compare-And-Swap locks (`mesh/locks/<agent>.lock`) with autonomous stale recovery |
| **Live Registry & Purifier** | Non-blocking live scrape & ultra-purified parser (`src/live-scraper.js`) with `15`-min TTL cache, prompt-injection stripping, and dynamic `.md` hydration (`intercom sync`) |
| **Prometheus Metrics** | Zero-dependency Prometheus exposition exporter (`/metrics`) tracking throughput, latency, and mailbox sizes |
| **Multi-Client Fast-Path SSE** | Real-time Server-Sent Events stream fanout with automatic client disconnect pruning |
| **Transactional Handoffs** | Zero-loss cross-agent task handoff protocol ensuring recipient confirmation before sender disconnect |
| **Multi-Channel Pub/Sub** | Dedicated broadcast channels (`#backend`, `#frontend`) with discrete file persistence |
| **Broadcast / Swarm** | 1-to-N delivery to any subset of agents simultaneously |
| **Dead Letter Queue (DLQ)** | Discrete DLQ (`mesh/dlq/<id>.json`) with background retry daemon and poison-pill isolation |
| **Mailbox Compaction** | Atomic pruning of empty ephemeral mailboxes and orphaned `.tmp` files (`intercom compact`) |
| **Daemon Manager** | Unified loopback HTTP/SSE daemon (`IntercomDaemon` + `router.js`) with PID supervision (`intercom daemon start/stop/status/run`) |
| **Live TUI Dashboard** | `intercom-tui` — OpenCode-inspired minimalist dashboard with Zen focus mode (`z`/`Z`), collapsible right sidebar, sub-tabs, `Activity` stream (`a`), and Readline editing |
| **Web Dashboard** | `examples/live-mesh-dashboard.html` — GitHub-dark SSE-powered UI |
| **MCP Server** | `11` tools (`send_message, receive_messages, interrupt_agent, get_agent_status, list_agents, intercom_send, intercom_wake, intercom_watch, intercom_read, intercom_clear, intercom_list_peers`) for Cursor / Claude Desktop / Antigravity via stdio (`intercom-global`) |
| **A2A Protocol** | Google A2A v1.0 agent card + task dispatch (`/.well-known/agent.json`) |
| **Cloud Task Offloading** | Google Jules (`gemini-3.6-flash`) cloud VM task offloading (`intercom jules check/dispatch/pull`) |
| **Production Hardening** | Automated teardown cleaners, Windows Defender tuning, and long path safety |

---

## 📊 Live Ecosystem & Registry Snapshot

- **Scrape Sources**: `https://models.dev/api.json, https://openrouter.ai/api/v1/models`
- **Purified Models Catalog**: `6729` models (`486` free-tier models)
- **Top Ranked Free Models**: `opencode/beam-free, opencode/cat-jam-free, opencode/crouton-alpha-free, opencode/exo-free, opencode/fledge-alpha-free`
- **Default Routing Chain**: `opencode -> claude -> hermes -> local-mesh (Zero-Qoder enforced)`
- **Default Models**: Primary `opencode/beam-free` · Fallback `opencode/cat-jam-free` · Scaffold `minimax/MiniMax-M3.1-Flash-Preview` · Claude `anthropic/claude-sonnet-4.6` · Jules `gemini-3.6-flash`
- **Zero-Qoder Explicit Free Allowlist**: `qwen3.8-flash, qwen3.8, qoder/qwen3.8-flash, glm-5.3-flash, deepseek-flash, minimax-m3.1-flash` (Qoder is barred from automatic routing)
- **Runtime Mesh**: `3` active peers (`antigravity, claude, opencode`) · `4219` active tasks · `0` active cloud sessions · Sample ID `1795604817027_2_28c8d57e-1b2c-43b1-97f4-6c70de4c7328`

### Top Live `$0.00` Free Models

| Model | Provider | Tier | Context | Reasoning | Score |
|---|---|---|---|---|---|
| `opencode/beam-free` | opencode | FREE ($0.00) | 1049k | Yes | 115 |
| `opencode/cat-jam-free` | opencode | FREE ($0.00) | 1049k | Yes | 115 |
| `opencode/crouton-alpha-free` | opencode | FREE ($0.00) | 1049k | Yes | 115 |
| `opencode/exo-free` | opencode | FREE ($0.00) | 1049k | Yes | 115 |
| `opencode/fledge-alpha-free` | opencode | FREE ($0.00) | 1049k | Yes | 115 |
| `opencode/hy4-flash-free` | opencode | FREE ($0.00) | 1049k | Yes | 115 |
| `opencode/inkling-2-small-free` | opencode | FREE ($0.00) | 1049k | Yes | 115 |
| `opencode/mimo-v2-pro-free` | opencode | FREE ($0.00) | 1049k | Yes | 115 |

### Supported Harnesses (`13` Registered)

| Harness | Status | Streaming | Sessions | Reasoning | Zero-Qoder Policy |
|---|---|---|---|---|---|
| `opencode` | INSTALLED | Yes | Yes | Yes | Compliant (Auto-Eligible) |
| `claude` | INSTALLED | Yes | Yes | Yes | Compliant (Auto-Eligible) |
| `hermes` | AVAILABLE | Yes | Yes | Yes | Compliant (Auto-Eligible) |
| `pi` | AVAILABLE | Yes | Yes | Yes | Compliant (Auto-Eligible) |
| `jules` | INSTALLED | No | Yes | Yes | Compliant (Auto-Eligible) |
| `codex` | INSTALLED | Yes | Yes | Yes | Compliant (Auto-Eligible) |
| `mcode` | INSTALLED | Yes | No | Yes | Compliant (Auto-Eligible) |
| `cursor` | AVAILABLE | Yes | Yes | Yes | Compliant (Auto-Eligible) |
| `windsurf` | AVAILABLE | Yes | Yes | Yes | Compliant (Auto-Eligible) |
| `vscode` | INSTALLED | Yes | Yes | No | Compliant (Auto-Eligible) |
| `antigravity` | AVAILABLE | Yes | Yes | Yes | Compliant (Auto-Eligible) |
| `qoder` | BARRED_AUTO | Yes | Yes | Yes | Explicit Free-Tier Only |
| `custom` | AVAILABLE | No | No | No | Compliant (Auto-Eligible) |

---

## 🚀 Quick Start

### Install
```bash
git clone https://github.com/Suran123s/intercom-global.git
cd intercom-global
npm install
npm link   # makes `intercom` available globally
```

### 1. Start the daemon
```bash
intercom daemon start          # persistent background process (http://127.0.0.1:4150)
intercom daemon status         # check PID and port
intercom daemon stop           # graceful shutdown
```

### 2. Sync live model & harness registries
```bash
intercom sync                  # refresh purified live cache (TTL: 15 min)
intercom sync --hydrate templates/README.md --out README.md   # hydrate template into README.md
intercom sync --vars           # print canonical dynamic variable JSON
```

### 3. Send a message
```bash
intercom send opencode "Review auth.ts and add JWT validation (model: opencode/beam-free)" --from antigravity
intercom send claude "Explain this codebase" --from me
```

### 4. Read & watch inbox
```bash
intercom read opencode         # read all messages
intercom watch opencode        # stream incoming messages reactively
intercom watch opencode --json # pipe-friendly JSON output
```

### 5. Inspect Prometheus metrics
```bash
intercom metrics                       # format 0.0.4 text exposition
intercom metrics --json                # JSON summary of active mailboxes, locks, DLQ
curl http://127.0.0.1:4150/metrics                   # Prometheus scrape endpoint
```

---

## 🛠️ Complete CLI Command Reference (18 Commands)

```
================================================================================
           🌐 INTERCOM GLOBAL - UNIVERSAL CROSS-IDE MULTI-AGENT CLI
================================================================================

1.  intercom send <recipient> <message> [options]
      Dispatches discrete message to target agent mailbox:
      --from <sender>           Sending agent name (default: operator)
      --type <type>             task_dispatch, task_response, interrupt, heartbeat, ack
      --priority <priority>     LOW, NORMAL, HIGH, CRITICAL (default: NORMAL)
      --correlation-id <id>     Correlation UUID linking request to response
      --parent-id <id>          Parent session UUID

2.  intercom watch <agent> [options]
      Listens reactively to incoming messages for the agent via Fast-Path SSE
      stream (with automatic Safe-Path file-mesh fallback).
      --json                    Output JSON array on message arrival
      --timeout <sec>           Block up to timeout seconds

3.  intercom daemon <start|stop|status|run> [--port <port>]
      Manages the background loopback HTTP/SSE daemon (http://127.0.0.1:4150):
      start                     Launches detached background service
      stop                      Gracefully terminates daemon
      status                    Displays PID, uptime, and port health
      run                       Runs foreground process (for systemd / Docker)

4.  intercom register <agent> [options]
      Registers agent state card in discovery registry:
      --ide <ide>               opencode, claude, hermes, pi, jules, codex, mcode, cursor, windsurf, vscode, antigravity, qoder, custom
      --role <role>             worker, reviewer, auditor, explorer, coordinator...
      --capabilities <c1,c2>    Comma-separated list of capabilities

5.  intercom interrupt <agent> [options]
      Issues real-time 3-tier interruption to target agent:
      --reason <reason>         Reason for redirection or halt
      --mode <auto|pty|jsonrpc|mesh>

6.  intercom ack <agent> <messageId> [--unlink]
      Acknowledges message in agent's inbox, moving it to archive or unlinking.

7.  intercom compact [agent] [options]
      Prunes empty ephemeral mailboxes and orphaned temp files in mesh/inbox:
      --dry-run                 Simulates compaction without deleting files
      --no-empty                Do not remove empty mailbox directories
      --temp-ttl <ms>           Age threshold for temp file pruning (default: 60000ms)

8.  intercom dlq <list|show|clear> [options]
      Manages Dead Letter Queue for failed deliveries:
      list [--json] [--limit <n>]  Lists failed messages in DLQ
      show <id> [--json]           Displays failure diagnostics for specific message
      clear                        Purges all dead-letter messages

9.  intercom channel <send|list|read> [options]
      Publishes and inspects broadcast channels:
      send <#channel> <message> [--from <sender>]
      list [--json]
      read <#channel> [--limit <n>] [--json]

10. intercom handoff <init|accept|complete|reject|status> [options]
      Zero-loss transactional cross-agent task handoff protocol:
      init <toAgent> <taskId> [payloadJson] [--from <sender>] [--timeout <sec>]
      accept <ticketId> [--agent <recipient>]
      complete <ticketId> [resultJson] [--from <sender>]
      reject <ticketId> [reason] [--agent <recipient>]
      status <ticketId> [--json]

11. intercom peers
      Lists all connected Fast-Path peers, active mailboxes, and registered agents.

12. intercom jules <check|dispatch|list|pull> [options]
      Manages Google Jules (gemini-3.6-flash) cloud VM task offloading:
      check                     Verifies CLI auth, git status, and concurrency/daily quota
      dispatch <spec.json>      Validates 5-pillar spec and dispatches task to Jules
      list                      Lists active and completed remote Jules sessions
      pull <sessionId> [--apply] Fetches or applies session patch

13. intercom governance <check|verify-action> [options]
      Enforces Teamwork Execution & Governance Invariants:
      check <agent>             Inspects subagent reuse cycles and rotation status
      verify-action <agent> <action>
                                Verifies action against Zero-Kill Protocol (INVIOLABLE)

14. intercom metrics [--json]
      Displays real-time Prometheus observability metrics (throughput, latency,
      active mailboxes, DLQ size, and CAS locks).

15. intercom doctor
      Executes comprehensive health, permissions, and network diagnostics.

16. intercom sync [--force] [--offline] [--hydrate [file]] [--write] [--out <file>] [--vars] [--url <url>] [--json]
      Scrapes live open registries, purifies payloads, updates TTL cache, and
      hydrates dynamic markdown variables.

17. intercom mcp
      Launches Model Context Protocol (MCP) stdio server (11 tools).

18. intercom tui
      Launches the interactive OpenCode-inspired terminal UI dashboard (`bin/intercom-tui.js`).

(Additional legacy aliases: `read`, `check`, `clear`, `server`, `help`)
================================================================================
```

---

## 🛠️ HTTP API Reference

Start the daemon first: `intercom daemon start` (default `http://127.0.0.1:4150`). Both `IntercomDaemon` (`src/core/daemon.js`) and `src/core/server.js` route all HTTP requests through the unified central router (`src/routes/router.js`).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` or `/api/intercom/health` | Daemon health, PID, uptime, and port |
| `GET` | `/metrics` or `/api/intercom/metrics` | Prometheus 0.0.4 text exposition metrics |
| `GET` | `/api/intercom/events?agent=<n>` | SSE stream (real-time events; alias `/api/intercom/stream`) |
| `GET` | `/api/intercom/peers` | List connected SSE peers and registered/active mailboxes |
| `POST` | `/api/intercom/send` | Send direct message `{from, to, message}` (alias `POST /messages`) |
| `POST` | `/api/intercom/broadcast` | Broadcast `{from, to:"a,b,c", message}` |
| `GET` | `/api/intercom/inbox?agent=<n>` | Read and mark unread messages for an agent |
| `GET` | `/api/intercom/channels` | List all topic channels |
| `POST` | `/api/intercom/channels/send` | Publish `{channel, from, message}` |
| `GET` | `/api/intercom/channels/<name>` | Read channel messages |
| `GET` | `/api/intercom/dlq` | List failed deliveries |
| `POST` | `/api/intercom/dlq/clear` | Clear DLQ |
| `POST` | `/api/intercom/spawn` | Spawn agent `{agent: "opencode"}` |
| `POST` | `/api/intercom/ack` | ACK task `{agent, messageId, status, result}` |
| `GET` | `/api/intercom/status/<agent>/<id>` | Query task status |
| `POST` | `/api/intercom/interrupt` | Issue real-time interruption `{agent, reason}` |
| `POST` | `/api/intercom/shutdown` | Graceful daemon shutdown |
| `GET` | `/api/intercom/doctor` | Full mesh health probe |
| `GET` | `/.well-known/agent.json` | Google A2A v1.0 agent card (aliases `/a2a/agent-card`, `/a2a/v1/agent-card`) |
| `POST` | `/a2a/sendMessage` | Google A2A task dispatch (aliases `/a2a/v1/sendMessage`, `/a2a/tasks`) |
| `GET` | `/a2a/tasks/<id>` | Query A2A task status (alias `/a2a/v1/tasks/<id>`) |

---

## 📋 Discrete Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AGENT RUNTIME LAYER                             │
│   Active Harnesses: opencode, claude, jules, codex, mcode, vscode                               │
└────────┬──────────────┬──────────────┬──────────────┬─────────────┬────┘
         │              │              │              │             │
         ▼              ▼              ▼              ▼             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   FAST-PATH (In-Memory / SSE <=1ms)                    │
│         Server-Sent Events Broadcast & FastQueue Pub/Sub               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Fallback & Persistence)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   SAFE-PATH (Discrete NTFS File-Mesh)                  │
│                                                                        │
│   mesh/inbox/<agent>/<timestamp>_<uuid>.json  (Atomic Discrete Files)  │
│   mesh/locks/<agent>.lock/metadata.json       (CAS Advisory Locks)     │
│   mesh/dlq/<uuid>.json                        (Discrete DLQ Storage)   │
│   mesh/handoffs/<ticketId>.json               (Zero-Loss Handoffs)     │
│   mesh/heartbeats/<agent>.json                (Liveness Heartbeats)    │
│   mesh/purified-live-cache.json               (Purified Live Cache)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   OBSERVABILITY & MONITORING (/metrics)                │
│    Zero-Dependency Prometheus Exporter (0.0.4 text format)             │
│    Throughput Counters · Latency Histograms · Mailbox/DLQ Gauges       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🖥️ Clean TUI Guidelines & OpenCode Minimalist Standard

The Intercom Global TUI (`intercom tui` or `bin/intercom-tui.js`) adheres to the **OpenCode Minimalist Standard**, emphasizing focus, whitespace, and serenity over noisy wall-to-wall border grids:

1. **Minimalist Workspace & Collapsible Right Sidebar**:
   - Opens with the right sidebar collapsed (`rightSidebarOpen = false`), presenting a centered composer (`✉ Intercom`), target selector (`To: [ @peer ▾ ]`), and `/` live slash-command menu.
   - Row-1 top bar exposes clickable sub-tabs (`[ ✦ Home ]`, `@peer`, `#channel`, `[ + New ]`) and a top-right `[ ☰ Menu ]` toggle (`Ctrl+B`) for the collapsible right sidebar.
   - Primary navigation categories (`NAV_TABS`): `Home`, `Inbox`, `Channels`, `Peers`, `Info`, `Settings`, `Help`, plus the live `Activity` log (`a` key / `[ Activity ]`).
2. **Zen / Focus Mode (`z` / `Z`)**:
   - Single-key instant toggle (`z`, `Z`, or `Ctrl+Z` when composer is unfocused; `Esc` to exit) that strips away top bars, sidebars, and lower-corner telemetry stats.
   - Focuses strictly on conversation history and active message composition for distraction-free developer workflows.
3. **Ergonomic Line Editing & Readline Shortcuts**:
   - `Ctrl+A` / `Home`: Jump cursor to start of line.
   - `Ctrl+E` / `End`: Jump cursor to end of line.
   - `Ctrl+K`: Kill line from cursor to end.
   - `Ctrl+U`: Clear entire input from cursor to start.
   - `Ctrl+W`: Delete previous word before cursor.
   - `Alt+B` / `Ctrl+Left`: Backward word navigation.
   - `Alt+F` / `Ctrl+Right`: Forward word navigation.
   - `Alt+D` / `Ctrl+Delete`: Forward word deletion.
4. **Visual Focus Rings & Clickable Hitboxes**:
   - Active cards and inputs feature clear high-contrast focus rings and terminal-escape sanitization (`sanitizeTerminalText`).
   - Action pills (`[ ↵ Send ]`, `[ ☰ Menu ]`, `[ ↻ Refresh ]`, `[ + New ]`) register exact SGR 1006 mouse hitboxes for point-and-click usability.

---

## 🌐 Peer Discovery Standards & Mesh Communication Patterns

Intercom Global implements an enterprise-grade, deterministic mesh protocol across all `opencode, claude, hermes, pi, jules, codex, mcode, cursor, windsurf, vscode, antigravity, qoder, custom` environments:

### 1. Peer Discovery & Liveness Heartbeats
- **Dynamic Registry & Inboxes**: Agents register in `mesh/registry/<agent>.json` (`120s` default stale threshold in `src/core/registry.js`) and maintain active inboxes under `mesh/inbox/<agent>/`.
- **Heartbeat Manifests**: Active companions emit periodic heartbeats to `mesh/heartbeats/<agent>.json` recording timestamp, operational state (`online`, `idle`, `busy`, `waiting`), and active task references. `HeartbeatRegistry` (`src/core/mesh.js`) defaults to a `30s` live TTL (`ttlMs = 30000`) and `60s` stale eviction TTL (`ttlMs = 60000`).
- **Ephemeral Mailbox Pruning**: Discovery scans cleanly filter out temporary test mailboxes (`test_`, `test-`, `tmp_`, `fuzz_`, `task-`, or numeric PID suffixes), ensuring production rosters remain tidy.
- **Autonomous CAS Cleanup**: Stale directory locks and expired `.tmp` envelope files are safely pruned using Compare-And-Swap (CAS) TTL recovery (`intercom compact`).

### 2. Mesh Communication Patterns
- **Point-to-Point (P2P) Atomic Envelopes**:
  - Discrete message files (`mesh/inbox/<agent>/<timestamp>_<uuid>.json`) written atomically via temp-file swap.
  - Zero lock contention between independent recipients.
- **Channel Pub/Sub**:
  - Discrete broadcast topics (`mesh/channels/<name>.json`) with deduplicated subscriber delivery.
- **Transactional Zero-Loss Handoffs**:
  - Cross-agent delegation protocol (`mesh/handoffs/<ticketId>.json`) requiring recipient acceptance verification before releasing sender tasks.
- **Dual-Speed Dispatch**:
  - **Fast-Path**: In-memory Server-Sent Events (SSE) stream fanout with sub-millisecond latency (<=1ms) for real-time daemon subscribers.
  - **Safe-Path**: NTFS discrete file-mesh providing indestructible persistence across process restarts and network interruptions.
- **Dead Letter Queue (DLQ)**:
  - Poison-pill isolation (`mesh/dlq/<uuid>.json`) preventing broken payloads from blocking subsequent messages, backed by an autonomous retry daemon.

---

## 🧪 Comprehensive Verification & Stress Testing

The Intercom Global Mesh (`@advance/intercom-global` v2.0.0) includes `55` test files covering unit, integration, concurrency, fuzzing, live-scraping, and adversarial stress tests:

```bash
# Full project test suite (288 passing tests across 55 test files)
npm test

# Milestone 4 Concurrency, Observability & Hardening Stress Suites:
node --test test/stress-compaction.test.js      # Mailbox Compaction Stress Test (#90)
node --test test/stress-ntfs-contention.test.js  # Real NTFS Lock Contention (#91)
node --test test/sse-multiclient.test.js        # Multi-Client Fast-Path SSE (#92)
node --test test/fuzz-payload.test.js           # Message Payload Fuzzing (#93)
node --test test/m4-metrics-prometheus.test.js  # Prometheus Metrics Exporter (#94)
node --test test/helpers/cleaner.test.js        # Standardized Teardown Cleaners (#95)
node --test test/live-scraper.test.js           # Live Scraper, Purifier & Hydration
```

For production deployment instructions, Windows Defender tuning, systemd/NSSM service files, and Prometheus scrape configs, see:
📘 **[Production Deployment & Hardening Guide](docs/PRODUCTION_DEPLOYMENT.md)**

---

## License

MIT © Suran
