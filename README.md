# 📡 Intercom Global

**Universal Multi-Agent Communication Mesh** — send, broadcast, wake, watch, and coordinate AI agents (OpenCode, Hermes, Pi, Cursor, Antigravity, and more) across terminals, IDEs, and APIs in real time.

[![Node.js](https://img.shields.io/badge/Node.js-%3E=18-brightgreen)](https://nodejs.org) [![Tests](https://img.shields.io/badge/tests-20%20passing-brightgreen)](#) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## ✨ Features

| Feature | Description |
|---|---|
| **Direct Messaging** | Agent-to-agent messages via durable file mailboxes |
| **Multi-Channel Pub/Sub** | Topic channels (`#backend`, `#frontend`) with pub/sub |
| **Broadcast / Swarm** | 1-to-N delivery to any subset of agents simultaneously |
| **Auto-Wake** | Interrupt OpenCode (REST), Hermes (HTTP), Pi (IPC), or Cloud agents |
| **Dead Letter Queue** | Failed deliveries saved with reason + exponential backoff retry |
| **Daemon Manager** | Persistent background HTTP daemon with PID file start/stop/status |
| **Live TUI Dashboard** | `intercom tui` — blessed split-pane terminal dashboard with file watcher |
| **Web Dashboard** | `examples/live-mesh-dashboard.html` — GitHub-dark SSE-powered UI |
| **MCP Server** | 14 tools for Cursor / Claude Desktop / Antigravity via stdio |
| **A2A Protocol** | Google A2A v1.0 agent card + task dispatch (`/.well-known/agent.json`) |
| **OS Notifications** | Desktop toast (Windows/macOS/Linux) on new messages |
| **Auto-Spawn** | On-demand agent process spawning with health-check polling |

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
intercom daemon start          # persistent background process
intercom daemon status         # check PID and port
intercom daemon stop           # graceful shutdown
```

### 2. Send a message
```bash
intercom send --from antigravity --to opencode --msg "Review auth.ts and add JWT validation"
intercom send --from me --to hermes --msg "Explain this codebase"
```

### 3. Broadcast to multiple agents
```bash
intercom broadcast --from boss --to opencode,hermes,pal --msg "Sprint planning: build Stripe checkout"
intercom broadcast --from boss --to all --msg "New task dropped"
```

### 4. Read & watch inbox
```bash
intercom read --agent opencode                        # read all messages
intercom watch --agent opencode --timeout 60          # block until message arrives
intercom watch --agent opencode --json                # pipe-friendly JSON output
```

### 5. Topic channels
```bash
intercom channel send --channel '#backend' --from antigravity --msg "API is ready for review"
intercom channel read --channel '#backend'
intercom channel list
```

### 6. Auto-wake an agent
```bash
intercom wake --to opencode --msg "Implement /api/payments endpoint"
intercom wake --to hermes --msg "Debug this error" --autospawn   # spawns Hermes if offline
```

### 7. Open the live TUI dashboard
```bash
intercom tui        # blessed split-pane dashboard (keyboard-driven)
npm run tui         # same via npm
```
**TUI keybindings:** `↑↓` select agent · `Enter` open inbox · `s` send · `c` clear · `r` refresh · `Tab` focus panel · `q` quit

### 8. Open the web dashboard
```bash
start examples\live-mesh-dashboard.html   # Windows
open examples/live-mesh-dashboard.html    # macOS
# Requires: intercom daemon start first
```

### 9. Spawn an offline agent on demand
```bash
intercom spawn --agent opencode           # start OpenCode in background
intercom spawn --agent hermes --visible   # start Hermes in visible window
```

### 10. Task lifecycle & DLQ
```bash
# Mark task completed
intercom ack --agent opencode --id <msgId> --status COMPLETED

# Check task status
intercom status-task --agent opencode --id <msgId>

# View failed deliveries
intercom dlq list
intercom dlq clear
```

### 11. Diagnose mesh connectivity
```bash
intercom doctor   # probes all runtimes: Pi, OpenCode, Hermes, daemon
```

---

## 🛠️ HTTP API Reference

Start the daemon first: `intercom daemon start`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/intercom/peers` | List all agent mailboxes with unread counts |
| `POST` | `/api/intercom/send` | Send direct message `{from, to, message}` |
| `POST` | `/api/intercom/broadcast` | Broadcast `{from, to:"a,b,c", message}` |
| `GET` | `/api/intercom/inbox?agent=<n>` | Read all messages for an agent |
| `GET` | `/api/intercom/channels` | List all topic channels |
| `POST` | `/api/intercom/channels/send` | Publish `{channel, from, message}` |
| `GET` | `/api/intercom/channels/<name>` | Read channel messages |
| `GET` | `/api/intercom/events` | SSE stream (real-time events) |
| `GET` | `/api/intercom/dlq` | List failed deliveries |
| `POST` | `/api/intercom/dlq/clear` | Clear DLQ |
| `POST` | `/api/intercom/spawn` | Spawn agent `{agent: "opencode"}` |
| `POST` | `/api/intercom/ack` | ACK task `{agent, msgId, status, result}` |
| `GET` | `/api/intercom/status/<agent>/<msgId>` | Query task status |
| `GET` | `/api/intercom/doctor` | Full mesh health probe |
| `GET` | `/.well-known/agent.json` | A2A v1.0 agent card |

---

## 🤖 MCP Integration (Cursor / Claude Desktop / Antigravity)

Add to your MCP config (`claude_desktop_config.json` / `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "intercom": {
      "command": "node",
      "args": ["C:/path/to/intercom-global/bin/intercom-mcp.js"]
    }
  }
}
```

**Available MCP tools:** `intercom_send`, `intercom_broadcast`, `intercom_channel_send`, `intercom_channel_read`, `intercom_channel_list`, `intercom_wake`, `intercom_watch`, `intercom_read`, `intercom_clear`, `intercom_list_peers`, `intercom_spawn`, `intercom_ack`, `intercom_dlq_list`

---

## 📋 Architecture

```
Primary Channel (≤5ms):   Direct IPC / REST API
Fallback Channel:         Durable File Mailbox (mesh/<agent>.json)
Dead Letter Queue:        mesh/dlq.json — retried with exponential backoff
```

**Agent runtime compatibility:**
- `opencode` — REST API on `http://127.0.0.1:4096`
- `hermes` — HTTP Gateway on `http://127.0.0.1:8000`  
- `pi` — Named Pipe / Unix domain socket
- `cursor` / `claude` / `antigravity` — MCP stdio or file watcher
- Any agent — durable file mailbox (zero-install fallback)

---

## 🧪 Tests

```bash
npm test                             # 20 unit + integration tests
node test/e2e-opencode-hermes.js     # live E2E with mock servers
```

---

## 📂 Real-World Examples

| File | Description |
|---|---|
| `examples/fullstack-feature-swarm.js` | Stripe Checkout Integration swarm |
| `examples/github-pr-review-swarm.js` | Multi-agent GitHub PR review pipeline |
| `examples/live-mesh-dashboard.html` | Real-time SSE web dashboard |
| `docs/REAL_WORLD_EXAMPLES.md` | Supervisor-Worker, Peer Review patterns |

---

## License

MIT © Suran