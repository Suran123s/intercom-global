# 📖 Intercom Global Integration Guide & Agent Rules (`{{PROJECT_NAME}}` v{{PROJECT_VERSION}})

This guide provides step-by-step instructions to configure and use **`{{PROJECT_NAME}}`** (v{{PROJECT_VERSION}}, snapshot `{{CURRENT_DATE}}`) across all supported AI coding environments (`{{SUPPORTED_HARNESSES}}`).

> **Active Harnesses**: `{{ACTIVE_HARNESSES}}` · **Default Model**: `{{DEFAULT_MODEL}}` · **Daemon**: `{{DAEMON_URL}}`

---

## 🛠️ 1. IDE Setup (Cursor, Antigravity, VS Code, Claude Desktop)

### Adding the MCP Server

Add the following block to your MCP configuration file (`{{MCP_SERVER_NAME}}` exposes `{{MCP_TOOLS_COUNT}}` tools: `{{MCP_TOOLS_LIST}}`):
- **Cursor**: `Settings` ➔ `Features` ➔ `MCP Servers` (or `~/.cursor/mcp.json`)
- **Antigravity**: `~/.gemini/antigravity/mcp/` or MCP Server settings
- **Claude Desktop**: `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "{{MCP_SERVER_NAME}}": {
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
2. `{{PROJECT_NAME}}` automatically connects to Pi's background broker via named pipes/sockets.
3. Any message sent via `{{CLI_COMMAND}} send <session> "<task>"` or `intercom-wake <session> "<task>"` will trigger delivery and wakeup!

---

## 💻 3. Interactive CLI & REST Agents (`{{ACTIVE_HARNESSES}}`)

### OpenCode Integration (`{{DEFAULT_HARNESS}}`)
- **API Server Mode**: If running `opencode serve` (default port `4096`), sending or waking `opencode` automatically triggers a prompt in the active session via REST API using `{{DEFAULT_MODEL}}` (or `{{DEFAULT_FALLBACK_MODEL}}`).
- **TUI/CLI Bridge Mode**: Wrap the OpenCode terminal with the session bridge:
  ```powershell
  node src/bridges/session-bridge.js --agent {{DEFAULT_HARNESS}} -- opencode
  ```

### Hermes Agent Integration (Nous Research)
- **Gateway API Mode**: If running `hermes gateway` (default port `8000`), wake signals to `hermes` automatically dispatch prompts to Hermes via OpenAI-compatible endpoints.
- **TUI Mode**: Wrap Hermes interactive chat with the bridge:
  ```powershell
  node src/bridges/session-bridge.js --agent hermes -- hermes chat
  ```

### Live Registry Sync
```powershell
{{CLI_COMMAND}} sync --force
{{CLI_COMMAND}} sync --hydrate
```

---

## 📜 4. Snippet to Teach Agents How to Use Intercom

Copy and paste this section into your project's **`AGENTS.md`**, **`.cursorrules`**, or **`CLAUDE.md`** file so your AI coding companions know how to coordinate:

```markdown
## 📡 Multi-Agent Intercom Coordination

You have access to other companion AI agents running locally or in cloud sessions via `{{PROJECT_NAME}}` (v{{PROJECT_VERSION}}).

### When to coordinate with companion agents:
1. **Parallel Execution**: Delegate test runs, database audits, or frontend checks to active companions (`{{ACTIVE_PEERS_LIST}}`; supported harnesses: `{{ACTIVE_HARNESSES}}`).
2. **Consulting**: Ask a companion working on a related repository for interface definitions.
3. **Completion Updates**: Notify companions when major migrations or builds have finished.

### How to use:
- **Sync Live Variables**: `{{CLI_COMMAND}} sync`
- **Auto-Wake Shortcut**: `intercom-wake <agentName> "<instructions>"`
- **Send Message**: `{{CLI_COMMAND}} send <targetName> "<message>" --from <myName> --correlation-id {{SAMPLE_TASK_ID}}`
- **Reactive Watch (Zero-Polling)**: `{{CLI_COMMAND}} watch <myName> --timeout 300`
- **Check Messages**: `{{CLI_COMMAND}} check --agent <myName>`
- **Clear Inbox**: `{{CLI_COMMAND}} clear --agent <myName>`
- **MCP Tools (`{{MCP_TOOLS_COUNT}})**: Call `send_message`, `receive_messages`, `interrupt_agent`, `get_agent_status`, `list_agents`, or legacy aliases (`intercom_wake`, `intercom_send`, `intercom_watch`, `intercom_read`, `intercom_clear`, `intercom_list_peers`).
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
   `{{PROJECT_NAME}}` automatically fires the Devin API webhook to start the cloud task.

For Google Jules (`{{DEFAULT_JULES_MODEL}}`), run:
```powershell
{{CLI_COMMAND}} jules check
{{CLI_COMMAND}} jules list
```
