# 📡 Intercom Global (`{{PROJECT_NAME}}` v{{PROJECT_VERSION}})

**Universal Multi-Agent Communication Mesh** — send, broadcast, wake, watch, and coordinate AI agents (`{{SUPPORTED_HARNESSES}}`) across terminals, IDEs, and APIs in real time.

> **Version**: `{{PROJECT_VERSION}}` · **Snapshot Date**: `{{CURRENT_DATE}}` · **Last Live Sync**: `{{LAST_SYNCED_AT}}` (TTL: `{{CACHE_TTL_MINUTES}}` min)  
> **Active Harnesses**: `{{ACTIVE_HARNESSES}}` · **Default Model**: `{{DEFAULT_MODEL}}` · **Active Peers**: `{{ACTIVE_PEERS_COUNT}}` (`{{ACTIVE_PEERS_LIST}}`)

[![Node.js](https://img.shields.io/badge/Node.js-{{NODE_MIN_VERSION}}-brightgreen)](https://nodejs.org) [![Version](https://img.shields.io/badge/version-{{PROJECT_VERSION}}-blue)](#) [![Tests](https://img.shields.io/badge/tests-{{TESTS_COUNT}}-brightgreen)](#) [![Prometheus](https://img.shields.io/badge/Prometheus-%2Fmetrics-orange)]({{DAEMON_URL}}/metrics) [![Architecture](https://img.shields.io/badge/architecture-Discrete%20NTFS%20Mesh-blue)](#) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## ✨ Features

| Feature | Description |
|---|---|
| **Discrete File-Mesh** | Atomic per-message envelopes (`mesh/inbox/<agent>/<ts>_<uuid>.json`) eliminating monolithic file write races |
| **Atomic NTFS CAS Locks** | Directory-based Compare-And-Swap locks (`mesh/locks/<agent>.lock`) with autonomous stale recovery |
| **Live Registry & Purifier** | Non-blocking live scrape & ultra-purified parser (`src/live-scraper.js`) with `{{CACHE_TTL_MINUTES}}`-min TTL cache, prompt-injection stripping, and dynamic `.md` hydration (`{{CLI_COMMAND}} sync`) |
| **Prometheus Metrics** | Zero-dependency Prometheus exposition exporter (`/metrics`) tracking throughput, latency, and mailbox sizes |
| **Multi-Client Fast-Path SSE** | Real-time Server-Sent Events stream fanout with automatic client disconnect pruning |
| **Transactional Handoffs** | Zero-loss cross-agent task handoff protocol ensuring recipient confirmation before sender disconnect |
| **Multi-Channel Pub/Sub** | Dedicated broadcast channels (`#backend`, `#frontend`) with discrete file persistence |
| **Broadcast / Swarm** | 1-to-N delivery to any subset of agents simultaneously |
| **Dead Letter Queue (DLQ)** | Discrete DLQ (`mesh/dlq/<id>.json`) with background retry daemon and poison-pill isolation |
| **Mailbox Compaction** | Atomic pruning of empty ephemeral mailboxes and orphaned `.tmp` files (`{{CLI_COMMAND}} compact`) |
| **Daemon Manager** | Background HTTP/WebSocket daemon with PID supervision (`{{CLI_COMMAND}} daemon start/stop/status`) |
| **Live TUI Dashboard** | `intercom-tui` — OpenCode-inspired minimalist dashboard with Zen focus mode, 4-tab workflow, and Readline editing |
| **Web Dashboard** | `examples/live-mesh-dashboard.html` — GitHub-dark SSE-powered UI |
| **MCP Server** | `{{MCP_TOOLS_COUNT}}` tools (`{{MCP_TOOLS_LIST}}`) for Cursor / Claude Desktop / Antigravity via stdio (`{{MCP_SERVER_NAME}}`) |
| **A2A Protocol** | Google A2A v1.0 agent card + task dispatch (`/.well-known/agent.json`) |
| **Cloud Task Offloading** | Google Jules (`{{DEFAULT_JULES_MODEL}}`) cloud VM task offloading (`{{CLI_COMMAND}} jules check/dispatch/pull`) |
| **Production Hardening** | Automated teardown cleaners, Windows Defender tuning, and long path safety |

---

## 📊 Live Ecosystem & Registry Snapshot

- **Scrape Sources**: `{{SCRAPE_SOURCES}}`
- **Purified Models Catalog**: `{{LIVE_MODEL_COUNT}}` models (`{{TOP_FREE_MODELS_COUNT}}` free-tier models)
- **Top Ranked Free Models**: `{{TOP_FREE_MODELS}}`
- **Default Routing Chain**: `{{FALLBACK_CHAIN}}`
- **Default Models**: Primary `{{DEFAULT_MODEL}}` · Fallback `{{DEFAULT_FALLBACK_MODEL}}` · Scaffold `{{DEFAULT_SCAFFOLD_MODEL}}` · Claude `{{DEFAULT_CLAUDE_MODEL}}` · Jules `{{DEFAULT_JULES_MODEL}}`
- **Zero-Qoder Explicit Free Allowlist**: `{{QODER_ALLOWED_MODELS}}` (Qoder is barred from automatic routing)
- **Runtime Mesh**: `{{ACTIVE_PEERS_COUNT}}` active peers (`{{ACTIVE_PEERS_LIST}}`) · `{{ACTIVE_TASKS_COUNT}}` active tasks · `{{ACTIVE_SESSIONS_COUNT}}` active cloud sessions · Sample ID `{{SAMPLE_TASK_ID}}`

### Top Live `$0.00` Free Models

{{LIVE_FREE_MODELS_TABLE}}

### Supported Harnesses (`{{HARNESSES_COUNT}}` Registered)

{{HARNESSES_TABLE}}

---

## 🚀 Quick Start

### Install
```bash
git clone {{REPO_URL}}.git
cd intercom-global
npm install
npm link   # makes `{{CLI_COMMAND}}` available globally
```

### 1. Start the daemon
```bash
{{CLI_COMMAND}} daemon start          # persistent background process ({{DAEMON_URL}})
{{CLI_COMMAND}} daemon status         # check PID and port
{{CLI_COMMAND}} daemon stop           # graceful shutdown
```

### 2. Sync live model & harness registries
```bash
{{CLI_COMMAND}} sync                  # refresh purified live cache (TTL: {{CACHE_TTL_MINUTES}} min)
{{CLI_COMMAND}} sync --hydrate        # hydrate dynamic template tokens in markdown docs
{{CLI_COMMAND}} sync --vars           # print canonical dynamic variable JSON
```

### 3. Send a message
```bash
{{CLI_COMMAND}} send {{DEFAULT_HARNESS}} "Review auth.ts and add JWT validation (model: {{DEFAULT_MODEL}})" --from antigravity
{{CLI_COMMAND}} send claude "Explain this codebase" --from me
```

### 4. Read & watch inbox
```bash
{{CLI_COMMAND}} read {{DEFAULT_HARNESS}}         # read all messages
{{CLI_COMMAND}} watch {{DEFAULT_HARNESS}}        # stream incoming messages reactively
{{CLI_COMMAND}} watch {{DEFAULT_HARNESS}} --json # pipe-friendly JSON output
```

### 5. Inspect Prometheus metrics
```bash
{{CLI_COMMAND}} metrics                       # format 0.0.4 text exposition
{{CLI_COMMAND}} metrics --json                # JSON summary of active mailboxes, locks, DLQ
curl {{DAEMON_URL}}/metrics                   # Prometheus scrape endpoint
```

---

## 🛠️ Complete CLI Command Reference ({{CLI_COMMANDS_COUNT}} Commands)

```
================================================================================
           🌐 INTERCOM GLOBAL - UNIVERSAL CROSS-IDE MULTI-AGENT CLI
================================================================================

1.  {{CLI_COMMAND}} send <recipient> <message> [options]
      Dispatches discrete message to target agent mailbox:
      --from <sender>           Sending agent name (default: operator)
      --type <type>             task_dispatch, task_response, interrupt, heartbeat, ack
      --priority <priority>     LOW, NORMAL, HIGH, CRITICAL (default: NORMAL)
      --correlation-id <id>     Correlation UUID linking request to response
      --parent-id <id>          Parent session UUID

2.  {{CLI_COMMAND}} watch <agent> [options]
      Listens reactively to incoming messages for the agent via Fast-Path SSE
      stream (with automatic Safe-Path file-mesh fallback).
      --json                    Output JSON array on message arrival
      --timeout <sec>           Block up to timeout seconds

3.  {{CLI_COMMAND}} daemon <start|stop|status|run> [--port <port>]
      Manages the background loopback HTTP daemon ({{DAEMON_URL}}):
      start                     Launches detached background service
      stop                      Gracefully terminates daemon
      status                    Displays PID, uptime, and port health
      run                       Runs foreground process (for systemd / Docker)

4.  {{CLI_COMMAND}} register <agent> [options]
      Registers agent state card in discovery registry:
      --ide <ide>               {{SUPPORTED_HARNESSES}}
      --role <role>             worker, reviewer, auditor, explorer, coordinator...
      --capabilities <c1,c2>    Comma-separated list of capabilities

5.  {{CLI_COMMAND}} interrupt <agent> [options]
      Issues real-time 3-tier interruption to target agent:
      --reason <reason>         Reason for redirection or halt
      --mode <auto|pty|jsonrpc|mesh>

6.  {{CLI_COMMAND}} ack <agent> <messageId> [--unlink]
      Acknowledges message in agent's inbox, moving it to archive or unlinking.

7.  {{CLI_COMMAND}} compact [agent] [options]
      Prunes empty ephemeral mailboxes and orphaned temp files in mesh/inbox:
      --dry-run                 Simulates compaction without deleting files
      --no-empty                Do not remove empty mailbox directories
      --temp-ttl <ms>           Age threshold for temp file pruning (default: 60000ms)

8.  {{CLI_COMMAND}} dlq <list|show|clear> [options]
      Manages Dead Letter Queue for failed deliveries:
      list [--json] [--limit <n>]  Lists failed messages in DLQ
      show <id> [--json]           Displays failure diagnostics for specific message
      clear                        Purges all dead-letter messages

9.  {{CLI_COMMAND}} channel <send|list|read> [options]
      Publishes and inspects broadcast channels:
      send <#channel> <message> [--from <sender>]
      list [--json]
      read <#channel> [--limit <n>] [--json]

10. {{CLI_COMMAND}} handoff <init|accept|complete|reject|status> [options]
      Zero-loss transactional cross-agent task handoff protocol:
      init <toAgent> <taskId> [payloadJson] [--from <sender>] [--timeout <sec>]
      accept <ticketId> [--agent <recipient>]
      complete <ticketId> [resultJson] [--from <sender>]
      reject <ticketId> [reason] [--agent <recipient>]
      status <ticketId> [--json]

11. {{CLI_COMMAND}} peers
      Lists all connected Fast-Path peers, active mailboxes, and registered agents.

12. {{CLI_COMMAND}} metrics [--json]
      Displays real-time Prometheus observability metrics (throughput, latency,
      active mailboxes, DLQ size, and CAS locks).

13. {{CLI_COMMAND}} jules <check|dispatch|list|pull> [options]
      Manages Google Jules ({{DEFAULT_JULES_MODEL}}) cloud VM task offloading:
      check                     Verifies CLI auth, git status, and concurrency/daily quota
      dispatch <spec.json>      Validates 5-pillar spec and dispatches task to Jules
      list                      Lists active and completed remote Jules sessions
      pull <sessionId> [--apply] Fetches or applies session patch

14. {{CLI_COMMAND}} governance <check|verify-action> [options]
      Enforces Teamwork Execution & Governance Invariants:
      check <agent>             Inspects subagent reuse cycles and rotation status
      verify-action <agent> <action>
                                Verifies action against Zero-Kill Protocol (INVIOLABLE)

15. {{CLI_COMMAND}} doctor
      Executes comprehensive health, permissions, and network diagnostics.

16. {{CLI_COMMAND}} sync [--force] [--hydrate [file]] [--write] [--vars] [--url <url>] [--json]
      Scrapes live open registries, purifies payloads, updates TTL cache, and
      hydrates dynamic markdown variables.

17. {{CLI_COMMAND}} mcp
      Launches Model Context Protocol (MCP) stdio server ({{MCP_TOOLS_COUNT}} tools).
================================================================================
```

---

## 🛠️ HTTP API Reference

Start the daemon first: `{{CLI_COMMAND}} daemon start` (default `{{DAEMON_URL}}`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/metrics` | Prometheus 0.0.4 text exposition metrics |
| `GET` | `/api/intercom/metrics` | Alias for `/metrics` |
| `GET` | `/api/intercom/events` | SSE stream (real-time events) |
| `GET` | `/api/intercom/peers` | List all agent mailboxes with unread counts |
| `POST` | `/api/intercom/send` | Send direct message `{from, to, message}` |
| `POST` | `/api/intercom/broadcast` | Broadcast `{from, to:"a,b,c", message}` |
| `GET` | `/api/intercom/inbox?agent=<n>` | Read all messages for an agent |
| `GET` | `/api/intercom/channels` | List all topic channels |
| `POST` | `/api/intercom/channels/send` | Publish `{channel, from, message}` |
| `GET` | `/api/intercom/channels/<name>` | Read channel messages |
| `GET` | `/api/intercom/dlq` | List failed deliveries |
| `POST` | `/api/intercom/dlq/clear` | Clear DLQ |
| `POST` | `/api/intercom/spawn` | Spawn agent `{agent: "{{DEFAULT_HARNESS}}"}` |
| `POST` | `/api/intercom/ack` | ACK task `{agent, messageId, status, result}` |
| `GET` | `/api/intercom/status/<agent>/<id>` | Query task status |
| `GET` | `/api/intercom/doctor` | Full mesh health probe |
| `GET` | `/.well-known/agent.json` | Google A2A v1.0 agent card |

---

## 📋 Discrete Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AGENT RUNTIME LAYER                             │
│   Active Harnesses: {{ACTIVE_HARNESSES}}                               │
└────────┬──────────────┬──────────────┬──────────────┬─────────────┬────┘
         │              │              │              │             │
         ▼              ▼              ▼              ▼             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   FAST-PATH (In-Memory / SSE ≤1ms)                     │
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

The Intercom Global TUI (`{{CLI_COMMAND}} tui` or `bin/intercom-tui.js`) adheres to the **OpenCode Minimalist Standard**, emphasizing focus, whitespace, and serenity over noisy wall-to-wall border grids:

1. **Focused Tabbed Layout**: Interface partitioned into 4 clean primary tabs:
   - `[1] 📥 Inbox`: Peer mailboxes, unread counts, and chronological message stream.
   - `[2] 📢 Channels`: Dedicated broadcast channels (`#backend`, `#frontend`, `#devops`) with threaded chat.
   - `[3] 🩺 Mesh Health`: Real-time node status, lock states, NTFS latency, and DLQ health.
   - `[4] ⚡ Activity`: Live event stream and transactional handoff tracking.
2. **Zen / Focus Mode (`z` / `Z`)**:
   - Single-key instant toggle that strips away KPI metric headers, borders, and secondary panels.
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
   - Active cards and inputs feature clear high-contrast focus rings.
   - Footer action pills (`[ ↵ Send ]`, `[ Tab Next ]`, `[ Esc Back ]`) register exact mouse hitboxes for point-and-click usability.

---

## 🌐 Peer Discovery Standards & Mesh Communication Patterns

Intercom Global implements an enterprise-grade, deterministic mesh protocol across all `{{SUPPORTED_HARNESSES}}` environments:

### 1. Peer Discovery & Liveness Heartbeats
- **Dynamic Registry & Inboxes**: Agents register in `mesh/registry/<agent>.json` and maintain active inboxes under `mesh/inbox/<agent>/`.
- **Heartbeat Manifests**: Active companions emit periodic heartbeats to `mesh/heartbeats/<agent>.json` recording timestamp, operational state (`idle`, `busy`, `waiting`), and active task references. Heartbeats older than 300s are automatically marked stale.
- **Ephemeral Mailbox Pruning**: Discovery scans cleanly filter out temporary test mailboxes (`test_`, `tmp_`, `fuzz_`, or numeric PID suffixes), ensuring production rosters remain tidy.
- **Autonomous CAS Cleanup**: Stale directory locks and expired `.tmp` envelope files are safely pruned using Compare-And-Swap (CAS) TTL recovery (`{{CLI_COMMAND}} compact`).

### 2. Mesh Communication Patterns
- **Point-to-Point (P2P) Atomic Envelopes**:
  - Discrete message files (`mesh/inbox/<agent>/<timestamp>_<uuid>.json`) written atomically via temp-file swap.
  - Zero lock contention between independent recipients.
- **Channel Pub/Sub**:
  - Discrete broadcast topics (`mesh/channels/<name>/<timestamp>_<uuid>.json`) with deduplicated subscriber delivery.
- **Transactional Zero-Loss Handoffs**:
  - Cross-agent delegation protocol (`mesh/handoffs/<ticketId>.json`) requiring recipient acceptance verification before releasing sender tasks.
- **Dual-Speed Dispatch**:
  - **Fast-Path**: In-memory Server-Sent Events (SSE) stream fanout with sub-millisecond latency (≤1ms) for real-time daemon subscribers.
  - **Safe-Path**: NTFS discrete file-mesh providing indestructible persistence across process restarts and network interruptions.
- **Dead Letter Queue (DLQ)**:
  - Poison-pill isolation (`mesh/dlq/<uuid>.json`) preventing broken payloads from blocking subsequent messages, backed by an autonomous retry daemon.

---

## 🧪 Comprehensive Verification & Stress Testing

The Intercom Global Mesh (`{{PROJECT_NAME}}` v{{PROJECT_VERSION}}) includes `{{TEST_SUITES_COUNT}}` test files covering unit, integration, concurrency, fuzzing, live-scraping, and adversarial stress tests:

```bash
# Full project test suite ({{TESTS_COUNT}} passing tests across {{TEST_SUITES_COUNT}} test files)
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
