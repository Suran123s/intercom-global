# 📖 Intercom Global Integration Guide & Agent Rules

This guide provides step-by-step instructions to configure and use **`intercom-global`** across all major AI coding environments (Cursor, Pi, Antigravity, OpenCode, VS Code, and Claude Desktop).

---

## 🛠️ 1. IDE Setup (Cursor, Antigravity, VS Code, Claude Desktop)

### Adding the MCP Server

Add the following block to your MCP configuration file:
- **Cursor**: `Settings` ➔ `Features` ➔ `MCP Servers` (or `~/.cursor/mcp.json`)
- **Antigravity**: `~/.gemini/antigravity/mcp/` or MCP Server settings
- **Claude Desktop**: `claude_desktop_config.json`

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
*(On Linux/macOS, replace the path with `/home/user/.intercom-global/bin/intercom-mcp.js` or `~/.intercom-global/bin/intercom-mcp.js`)*

---

## 🥧 2. Pi Coding Agent (`pi-intercom`) Integration

Pi coding agents use the official `pi-intercom` extension for native inter-session messaging.

1. **Install Pi Intercom**:
   ```bash
   pi install npm:pi-intercom
   ```
2. `intercom-global` automatically connects to Pi's background broker via named pipes/sockets.
3. Any message sent via `intercom pi send --to <session>` or `intercom-wake <session>` will instantly appear inside Pi and trigger an autonomous turn!

---

## 💻 3. Interactive CLI Integration (OpenCode, Aider, PowerShell)

Wrap any interactive CLI with the session bridge so it automatically listens for incoming tasks and types them into `stdin`:

```powershell
# Wraps OpenCode in an intercom listener named 'suraj'
intercom bridge --agent suraj -- opencode

# Wraps Aider in an intercom listener named 'refactor-bot'
intercom bridge --agent refactor-bot -- aider
```

---

## 📜 4. Snippet to Teach Agents How to Use Intercom

Copy and paste this section into your project's **`AGENTS.md`**, **`.cursorrules`**, or **`CLAUDE.md`** file so your AI coding companions know how to coordinate:

```markdown
## 📡 Multi-Agent Intercom Coordination

You have access to other companion AI agents running locally or in cloud sessions via `intercom-global`.

### When to coordinate with companion agents:
1. **Parallel Execution**: Delegate test runs, database audits, or frontend checks to companions (`pal`, `keshav`, `madhav`, `suraj`).
2. **Consulting**: Ask a companion working on a related repository for interface definitions.
3. **Completion Updates**: Notify companions when major migrations or builds have finished.

### How to use:
- **Auto-Wake / Immediate Turn**: `intercom wake --to <agentName> --msg "<instructions>"` or `intercom-wake <agentName> "<instructions>"`
- **Send Message**: `intercom send --from <myName> --to <targetName> --msg "<message>"`
- **Reactive Watch (Zero-Polling)**: `intercom watch --agent <myName> --timeout 300`
- **Check Messages**: `intercom check --agent <myName>`
- **Clear Inbox**: `intercom clear --agent <myName>`
- **MCP Tools**: Call `intercom_wake`, `intercom_send`, `intercom_watch`, `intercom_read`, or `intercom_clear` if MCP tools are available.
```

---

## ☁️ 5. Cloud Agent Integration (Devin)

To enable automatic cloud triggering for Devin:
1. Set your Devin API key in your environment:
   ```powershell
   $env:DEVIN_API_KEY="your_devin_api_key_here"
   ```
2. When you send a message or wake signal to `devin`:
   ```powershell
   intercom wake --to devin --msg "Fix bug in customer routes"
   ```
   `intercom-global` automatically fires the Devin API webhook to start the cloud task.
