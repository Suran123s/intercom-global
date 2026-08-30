# 📡 Intercom Global (`.intercom-global`)

> **Universal Multi-Agent Intercom, Auto-Wake & Cross-IDE Communication Mesh**  
> Connects **Pi (`pi-intercom`)**, **Antigravity**, **Cursor / VS Code**, **OpenCode / CLI**, and **Cloud Agents (Devin)** on the same machine.

---

## 🌟 Features

- **⚡ Native Pi-Intercom Bridge**: Connects directly to the Windows Named Pipe / Unix Socket broker used by [`nicobailon/pi-intercom`](https://github.com/nicobailon/pi-intercom).
- **🔔 Universal Auto-Wake & Interruption**: Interrupts and forces an immediate execution turn in Pi sessions, OpenCode CLIs, Antigravity, or Devin cloud VMs.
- **🌐 Agent2Agent (A2A) Protocol Bridge**: Implements A2A v1.0 standard with Agent Card discovery (`/.well-known/agent.json`), dynamic skill catalogues, and structured task lifecycle tracking.
- **🔌 Model Context Protocol (MCP) Server**: Stdio MCP server exposing `intercom_send`, `intercom_wake`, `intercom_watch`, `intercom_read`, `intercom_clear`, and `intercom_list_peers` to Cursor, Antigravity, and Claude Desktop with isolated stderr logging.
- **👀 Reactive Zero-Polling Watcher (`intercom watch`)**: Asynchronous mailbox monitor that instantly wakes when an unread task arrives.
- **🧠 Built-in Agent Skill**: Bundled [`skills/intercom-global/SKILL.md`](skills/intercom-global/SKILL.md) for self-discovering AI agents.
- **📖 Integration Guide & Agent Rules**: Ready-to-use snippets in [`docs/GUIDE.md`](docs/GUIDE.md) for `AGENTS.md` and `.cursorrules`.
- **📦 Durable File Mesh**: High-speed, lock-free JSON mailbox system with per-session routing (`agent#sessionId`).
- **💻 Interactive Session Bridge**: Stdin/Stdout terminal wrapper that injects autonomous tasks into running CLIs (OpenCode, Aider, Pi).
- **🌐 Standalone & Portable**: Completely isolated outside of individual project repositories.

---

## 🚀 Quick Install

### Option A: One-Click PowerShell (Windows)
```powershell
cd C:\Users\Suran\.intercom-global
.\install.ps1
```

### Option B: One-Click Bash (Linux / macOS / WSL)
```bash
cd ~/.intercom-global
./install.sh
```

### Option C: Manual Link & Test
```bash
npm install
npm test
npm link
```

---

## 🎮 CLI Usage

After installation, the `intercom` and `intercom-wake` CLI commands are available globally anywhere in your terminal:

### 1. Auto-Wake & Interrupt an AI Companion
```powershell
# Instantly interrupt and trigger an autonomous turn in Keshav's Pi session
intercom wake --to Keshav --msg "Check customer route tests"

# Shortcut command
intercom-wake Madhav "Audit the server routes"
```

### 2. Send, Watch & Check Messages
```powershell
# Send a message to any companion
intercom send --from Suran --to Pal --msg "All 488 Jest tests passed"

# Watch reactively for incoming tasks (zero-polling, wakes immediately on message arrival)
intercom watch --agent Suran --timeout 300

# Check your inbox and mark as read
intercom check --agent Suran

# Clear/empty your inbox
intercom clear --agent Suran

# View raw mailbox history
intercom read --agent Pal

# List all active companions and mailbox sizes
intercom peers
```

### 3. Agent2Agent (A2A) Commands
```powershell
# View the local mesh A2A Agent Card
intercom a2a card

# Send a task formatted as an A2A task
intercom a2a send --to Pal --msg "Run test verification"
```

### 4. Native Pi-Intercom IPC Commands
```powershell
# List all live Pi sessions connected on this machine
intercom pi list

# Send a native message directly into a Pi terminal
intercom pi send --to Madhav --msg "Here is the updated schema"

# Ask a question to a Pi session and wait for its reply
intercom pi ask --to Keshav --question "Which port is active?"
```

### 5. Interactive CLI Session Bridge
Run any CLI wrapped in an intercom listener that automatically injects tasks into its standard input:
```powershell
intercom bridge --agent suraj -- opencode
```

### 6. Start the Background HTTP & A2A Daemon
```powershell
intercom server --auto-reply
```
*(Provides `http://localhost:4150/.well-known/agent.json` and `http://localhost:4150/a2a/sendMessage`)*

---

## 🧩 Cursor / Antigravity MCP Configuration

Add this entry to your `mcpServers` configuration (e.g. `cursor_config.json` or `.gemini/antigravity/mcp/`):

```json
{
  "mcpServers": {
    "intercom-global": {
      "command": "node",
      "args": ["C:/Users/Suran/.intercom-global/bin/intercom-mcp.js"]
    }
  }
}
```

---

## 📜 License & Legal Information

This project is open-source software licensed under the [MIT License](LICENSE).

### Third-Party Acknowledgements
- **[nicobailon/pi-intercom](https://github.com/nicobailon/pi-intercom)**: Created by Nico Bailon under the MIT License. `intercom-global` connects to the local IPC protocol designed for Pi coding agents.
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol)**: Licensed under the MIT License.

### Trademark & Non-Affiliation Disclaimer
All product names, logos, and brands (including **Pi**, **Google Antigravity**, **Cursor**, **Devin**, **OpenCode**, and others) are trademarks or registered trademarks of their respective owners. Their mention in this repository is solely for compatibility, interoperability, and nominative identification, and does not imply any official endorsement, sponsorship, or affiliation.

