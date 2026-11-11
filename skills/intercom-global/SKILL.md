---
name: intercom-global
description: "Universal Multi-Agent Intercom, Auto-Wake, and Cross-IDE Coordination Skill. Use when coordinating, delegating tasks, asking blocking questions, or sending notifications across multiple local or remote AI agent sessions ({{SUPPORTED_HARNESSES}})."
---

# 📡 Intercom Global Agent Skill (`{{PROJECT_NAME}}` v{{PROJECT_VERSION}})

This skill teaches AI agents how to discover, communicate with, and delegate work to other AI companions running on the same machine or in cloud sessions.

> **Snapshot Date**: `{{CURRENT_DATE}}` · **Last Synced**: `{{LAST_SYNCED_AT}}` · **Daemon**: `{{DAEMON_URL}}`  
> **Active Harnesses**: `{{ACTIVE_HARNESSES}}` · **Active Mesh Peers (`{{ACTIVE_PEERS_COUNT}}`)**: `{{ACTIVE_PEERS_LIST}}`  
> **Default Model**: `{{DEFAULT_MODEL}}` · **Fallback Chain**: `{{FALLBACK_CHAIN}}`

---

## 🎯 When to Use This Skill

- **Task Delegation**: You are working on a backend task and need a companion (`{{ACTIVE_PEERS_LIST}}` or `{{DEFAULT_HARNESS}}`) to run test suites or frontend checks in parallel using `{{DEFAULT_MODEL}}` (or `{{TOP_FREE_MODELS}}`).
- **Consulting / Cross-Checking**: Asking a companion agent working on another codebase or subsystem for advice or schemas.
- **Long-Running Status Notifications**: Sending an update once a build, linting check, or migration has finished.
- **Interrupting / Auto-Waking**: Forcing an immediate autonomous execution turn in an idle companion session.

---

## 🛠️ Available Execution Methods

### Method 1: Using MCP Tools (Inside Cursor, Antigravity, Claude Desktop)
If your environment has the `{{MCP_SERVER_NAME}}` MCP server configured (`{{MCP_TOOLS_COUNT}}` tools: `{{MCP_TOOLS_LIST}}`), call the tools directly:

```json
// 1. Send a message/task to another companion (task ref: {{SAMPLE_TASK_ID}})
{
  "tool": "intercom_send",
  "arguments": {
    "from": "my-session-name",
    "to": "{{DEFAULT_HARNESS}}",
    "message": "Please review the updated Prisma schema using model {{DEFAULT_MODEL}}"
  }
}

// 2. Interrupt and auto-wake an agent immediately
{
  "tool": "intercom_wake",
  "arguments": {
    "targetAgent": "{{DEFAULT_HARNESS}}",
    "reason": "Run npm run test:all and report failures"
  }
}

// 3. Check your incoming inbox
{
  "tool": "intercom_read",
  "arguments": {
    "forAgent": "my-session-name"
  }
}

// 4. List all active companions on this machine
{
  "tool": "intercom_list_peers",
  "arguments": {}
}
```

---

### Method 2: Using the CLI in Terminal / Subprocess

If MCP tools are not directly available, execute the global CLI (`{{CLI_COMMAND}}`) via terminal:

#### 1. Sync Live Model & Harness Registries
```bash
{{CLI_COMMAND}} sync --force
{{CLI_COMMAND}} sync --hydrate
```

#### 2. Send a Notification or Task
```bash
{{CLI_COMMAND}} send {{DEFAULT_HARNESS}} "<message text>" --from <yourName> --correlation-id {{SAMPLE_TASK_ID}}
```

#### 3. Check for Incoming Tasks
```bash
{{CLI_COMMAND}} check --agent <yourName>
```

#### 4. Wait Reactively for Incoming Tasks (Zero-Polling)
```bash
{{CLI_COMMAND}} watch <yourName> --timeout 300
```

#### 5. List Active Peers & Transactional Handoffs
```bash
{{CLI_COMMAND}} peers
{{CLI_COMMAND}} handoff init <toAgent> {{SAMPLE_TASK_ID}} '{"model":"{{DEFAULT_MODEL}}"}' --from <yourName>
```

#### 6. Auto-Wake Shortcut
```bash
intercom-wake <agentName> "<task instructions>"
```

#### 7. Launch Modern OpenCode Intercom TUI Dashboard
```bash
{{CLI_COMMAND}} tui              # Interactive OpenCode minimalist dashboard (Inbox, Channels, Health, Activity)
# Keybindings:
# [1-4] or [Tab] Switch tabs ([1] Inbox, [2] Channels, [3] Mesh Health, [4] Activity)
# [z] / [Z] Toggle Zen / Focus mode (strips KPI bars down to pure conversation & compose stream)
# [s] / [↵] Send message | [c] Clear mailbox | [r] Refresh mesh status | [q] Quit
# Readline line-editing: Ctrl+A (Home), Ctrl+E (End), Ctrl+K (Kill), Ctrl+U (Clear), Ctrl+W (Delete word), Alt+B/F (Word jump)
```

---

## 🛡️ Zero-Qoder & Model Governance Policy

- **Default Routing Chain**: `{{FALLBACK_CHAIN}}`
- **Active Harnesses**: `{{ACTIVE_HARNESSES}}` (`{{HARNESSES_COUNT}}` supported total)
- **Zero-Qoder Invariant**: `qoder` is strictly barred from automatic routing and default fallback tiers. Explicit free-tier Qoder calls are limited to: `{{QODER_ALLOWED_MODELS}}` (default free model: `{{DEFAULT_QODER_FREE_MODEL}}`).

---

## 📋 Best Practices & Etiquette for AI Agents

1. **Prefer `{{CLI_COMMAND}} send` for fire-and-forget notifications**: Only use `wake` or `interrupt` when you are genuinely blocked and need an immediate response or execution turn.
2. **Be Clear & Self-Contained**: Always include file paths, specific function names, and context in your message so the receiving agent can act without asking follow-up questions.
3. **Acknowledge Receipts**: When you receive a task via `{{CLI_COMMAND}} check` or `intercom_read`, acknowledge it (`{{CLI_COMMAND}} ack`) or send a quick confirmation back so the sender knows work is underway.
