# 📡 Intercom Global

**Universal Multi-Agent Communication Mesh** — send, broadcast, wake, watch, and coordinate AI agents (OpenCode, Hermes, Pi, Cursor, Antigravity, and more) across terminals, IDEs, and APIs in real time.

[![Node.js](https://img.shields.io/badge/Node.js-%3E=18-brightgreen)](https://nodejs.org) [![Tests](https://img.shields.io/badge/tests-238%2B%20passing-brightgreen)](#) [![Prometheus](https://img.shields.io/badge/Prometheus-%2Fmetrics-orange)](http://127.0.0.1:4150/metrics) [![Architecture](https://img.shields.io/badge/architecture-Discrete%20NTFS%20Mesh-blue)](#) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## ✨ Features

| Feature | Description |
|---|---|
| **Discrete File-Mesh** | Atomic per-message envelopes (`mesh/inbox/<agent>/<ts>_<uuid>.json`) eliminating monolithic file write races |
| **Atomic NTFS CAS Locks** | Directory-based Compare-And-Swap locks (`mesh/locks/<agent>.lock`) with autonomous stale recovery |
| **Prometheus Metrics** | Zero-dependency Prometheus exposition exporter (`/metrics`) tracking throughput, latency, and mailbox sizes |
| **Multi-Client Fast-Path SSE** | Real-time Server-Sent Events stream fanout with automatic client disconnect pruning |
| **Transactional Handoffs** | Zero-loss cross-agent task handoff protocol ensuring recipient confirmation before sender disconnect |
| **Multi-Channel Pub/Sub** | Dedicated broadcast channels (`#backend`, `#frontend`) with discrete file persistence |
| **Broadcast / Swarm** | 1-to-N delivery to any subset of agents simultaneously |
| **Dead Letter Queue (DLQ)** | Discrete DLQ (`mesh/dlq/<id>.json`) with background retry daemon and poison-pill isolation |
| **Mailbox Compaction** | Atomic pruning of empty ephemeral mailboxes and orphaned `.tmp` files (`intercom compact`) |
| **Daemon Manager** | Background HTTP/WebSocket daemon with PID supervision (`intercom daemon start/stop/status`) |
| **Live TUI Dashboard** | `intercom tui` — blessed split-pane terminal dashboard with live file watcher |
| **Web Dashboard** | `examples/live-mesh-dashboard.html` — GitHub-dark SSE-powered UI |
| **MCP Server** | 14 tools for Cursor / Claude Desktop / Antigravity via stdio |
| **A2A Protocol** | Google A2A v1.0 agent card + task dispatch (`/.well-known/agent.json`) |
| **Cloud Task Offloading** | Google Jules cloud VM task offloading (`intercom jules check/dispatch/pull`) |
| **Production Hardening** | Automated teardown cleaners, Windows Defender tuning, and long path safety |

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
intercom daemon start          # persistent background process (127.0.0.1:4150)
intercom daemon status         # check PID and port
intercom daemon stop           # graceful shutdown
```

### 2. Send a message
```bash
intercom send opencode "Review auth.ts and add JWT validation" --from antigravity
intercom send hermes "Explain this codebase" --from me
```

### 3. Broadcast to multiple agents
```bash
intercom broadcast --from boss --to opencode,hermes,pal --msg "Sprint planning: build Stripe checkout"
intercom broadcast --from boss --to all --msg "New task dropped"
```

### 4. Read & watch inbox
```bash
intercom read opencode                        # read all messages
intercom watch opencode                       # stream incoming messages reactively
intercom watch opencode --json                # pipe-friendly JSON output
```

### 5. Inspect Prometheus metrics
```bash
intercom metrics                              # format 0.0.4 text exposition
intercom metrics --json                       # JSON summary of active mailboxes, locks, DLQ
curl http://127.0.0.1:4150/metrics            # Prometheus scrape endpoint
```

---

## 🛠️ Complete CLI Command Reference (15 Commands)

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
      Manages the background loopback HTTP daemon (127.0.0.1:4150):
      start                     Launches detached background service
      stop                      Gracefully terminates daemon
      status                    Displays PID, uptime, and port health
      run                       Runs foreground process (for systemd / Docker)

4.  intercom register <agent> [options]
      Registers agent state card in discovery registry:
      --ide <ide>               antigravity, cursor, windsurf, vscode, opencode, claude...
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

12. intercom metrics [--json]
      Displays real-time Prometheus observability metrics (throughput, latency,
      active mailboxes, DLQ size, and CAS locks).

13. intercom jules <check|dispatch|list|pull> [options]
      Manages Google Jules cloud VM task offloading:
      check                     Verifies CLI auth, git status, and concurrency/daily quota
      dispatch <spec.json>      Validates 5-pillar spec and dispatches task to Jules
      list                      Lists active and completed remote Jules sessions
      pull <sessionId> [--apply] Fetches or applies session patch

14. intercom governance <check|verify-action> [options]
      Enforces Teamwork Execution & Governance Invariants:
      check <agent>             Inspects subagent reuse cycles and rotation status
      verify-action <agent> <action>
                                Verifies action against Zero-Kill Protocol (INVIOLABLE)

15. intercom doctor
      Executes comprehensive health, permissions, and network diagnostics.
================================================================================
```

---

## 🛠️ HTTP API Reference

Start the daemon first: `intercom daemon start`

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
| `POST` | `/api/intercom/spawn` | Spawn agent `{agent: "opencode"}` |
| `POST` | `/api/intercom/ack` | ACK task `{agent, messageId, status, result}` |
| `GET` | `/api/intercom/status/<agent>/<id>` | Query task status |
| `GET` | `/api/intercom/doctor` | Full mesh health probe |
| `GET` | `/.well-known/agent.json` | Google A2A v1.0 agent card |

---

## 📋 Discrete Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AGENT RUNTIME LAYER                             │
│     OpenCode  │  Hermes  │  Claude Code  │  Antigravity  │  Cursor     │
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

## 🧪 Comprehensive Verification & Stress Testing

The Intercom Global Mesh includes a comprehensive suite of unit, integration, concurrency, fuzzing, and adversarial stress tests:

```bash
# Full project test suite (238+ passing tests)
npm test

# Milestone 4 Concurrency, Observability & Hardening Stress Suites:
node --test test/stress-compaction.test.js      # Mailbox Compaction Stress Test (#90)
node --test test/stress-ntfs-contention.test.js  # Real NTFS Lock Contention (#91)
node --test test/sse-multiclient.test.js        # Multi-Client Fast-Path SSE (#92)
node --test test/fuzz-payload.test.js           # Message Payload Fuzzing (#93)
node --test test/m4-metrics-prometheus.test.js  # Prometheus Metrics Exporter (#94)
node --test test/helpers/cleaner.test.js        # Standardized Teardown Cleaners (#95)
```

For production deployment instructions, Windows Defender tuning, systemd/NSSM service files, and Prometheus scrape configs, see:
📘 **[Production Deployment & Hardening Guide](docs/PRODUCTION_DEPLOYMENT.md)**

---

## License

MIT © Suran