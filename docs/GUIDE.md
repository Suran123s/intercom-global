# 📖 Intercom Global Integration Guide & Agent Rules (`@advance/intercom-global` v2.0.0)

This guide provides step-by-step instructions to configure and use **`@advance/intercom-global`** (v2.0.0, snapshot `2026-11-25`) across all supported AI coding environments (`opencode, claude, hermes, pi, jules, codex, mcode, cursor, windsurf, vscode, antigravity, qoder, custom`).

> **Active Harnesses**: `opencode, claude, jules, codex, mcode, vscode` · **Default Model**: `opencode/beam-free` · **Daemon**: `http://127.0.0.1:4150`

---

## 🛠️ 1. IDE Setup (Cursor, Antigravity, VS Code, Claude Desktop)

### Adding the MCP Server

Add the following block to your MCP configuration file (`intercom-global` exposes `11` tools: `send_message, receive_messages, interrupt_agent, get_agent_status, list_agents, intercom_send, intercom_wake, intercom_watch, intercom_read, intercom_clear, intercom_list_peers`):
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
2. `@advance/intercom-global` automatically connects to Pi's background broker via named pipes/sockets.
3. Any message sent via `intercom send <session> "<task>"` or `intercom-wake <session> "<task>"` will trigger delivery and wakeup!

---

## 💻 3. Interactive CLI & REST Agents (`opencode, claude, jules, codex, mcode, vscode`)

### OpenCode Integration (`opencode`)
- **API Server Mode**: If running `opencode serve` (default port `4096`), sending or waking `opencode` automatically triggers a prompt in the active session via REST API using `opencode/beam-free` (or `opencode/cat-jam-free`).
- **TUI/CLI Bridge Mode**: Wrap the OpenCode terminal with the session bridge:
  ```powershell
  node src/bridges/session-bridge.js --agent opencode -- opencode
  ```

### Hermes Agent Integration (Nous Research)
- **Gateway API Mode**: If running `hermes gateway` (default port `8000`), wake signals to `hermes` automatically dispatch prompts to Hermes via OpenAI-compatible endpoints.
- **TUI Mode**: Wrap Hermes interactive chat with the bridge:
  ```powershell
  node src/bridges/session-bridge.js --agent hermes -- hermes chat
  ```

### Live Registry Sync
```powershell
intercom sync --force
intercom sync --hydrate
```

---

## 📜 4. Snippet to Teach Agents How to Use Intercom

Copy and paste this section into your project's **`AGENTS.md`**, **`.cursorrules`**, or **`CLAUDE.md`** file so your AI coding companions know how to coordinate:

```markdown
## 📡 Multi-Agent Intercom Coordination

You have access to other companion AI agents running locally or in cloud sessions via `@advance/intercom-global` (v2.0.0).

### When to coordinate with companion agents:
1. **Parallel Execution**: Delegate test runs, database audits, or frontend checks to active companions (`antigravity, claude, opencode`; supported harnesses: `opencode, claude, jules, codex, mcode, vscode`).
2. **Consulting**: Ask a companion working on a related repository for interface definitions.
3. **Completion Updates**: Notify companions when major migrations or builds have finished.

### How to use:
- **Sync Live Variables**: `intercom sync`
- **Auto-Wake Shortcut**: `intercom-wake <agentName> "<instructions>"`
- **Send Message**: `intercom send <targetName> "<message>" --from <myName> --correlation-id 1795604817027_2_28c8d57e-1b2c-43b1-97f4-6c70de4c7328`
- **Reactive Watch (Zero-Polling)**: `intercom watch <myName> --timeout 300`
- **Check Messages**: `intercom check --agent <myName>`
- **Clear Inbox**: `intercom clear --agent <myName>`
- **MCP Tools (`11)**: Call `send_message`, `receive_messages`, `interrupt_agent`, `get_agent_status`, `list_agents`, or legacy aliases (`intercom_wake`, `intercom_send`, `intercom_watch`, `intercom_read`, `intercom_clear`, `intercom_list_peers`).
```

---

## ☁️ 5. Cloud Agent Integration (Devin & Google Jules)

To enable automatic cloud triggering for Devin:
1. Set your Devin API key in your environment:
   ```powershell
   $env:DEVIN_API_KEY="your_devin_api_key_here"
   ```
2. When you send a message or wake signal to `devin`:
   ```powershell
   intercom-wake --to devin --msg "Fix bug in customer routes"
   ```
   `@advance/intercom-global` automatically fires the Devin API webhook to start the cloud task.

For Google Jules (`gemini-3.6-flash`), run:
```powershell
intercom jules check
intercom jules list
```
