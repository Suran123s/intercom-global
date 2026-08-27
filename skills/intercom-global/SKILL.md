---
name: intercom-global
description: "Universal Multi-Agent Intercom, Auto-Wake, and Cross-IDE Coordination Skill. Use when coordinating, delegating tasks, asking blocking questions, or sending notifications across multiple local or remote AI agent sessions (Pi, Cursor, Antigravity, OpenCode, Devin)."
---

# 📡 Intercom Global Agent Skill

This skill teaches AI agents how to discover, communicate with, and delegate work to other AI companions running on the same machine or in cloud sessions.

---

## 🎯 When to Use This Skill

- **Task Delegation**: You are working on a backend task and need a companion (e.g. `pal` or `keshav`) to run test suites or frontend checks in parallel.
- **Consulting / Cross-Checking**: Asking a companion agent working on another codebase or subsystem for advice or schemas.
- **Long-Running Status Notifications**: Sending an update once a build, linting check, or migration has finished.
- **Interrupting / Auto-Waking**: Forcing an immediate autonomous execution turn in an idle companion session.

---

## 🛠️ Available Execution Methods

### Method 1: Using MCP Tools (Inside Cursor, Antigravity, Claude Desktop)
If your environment has the `intercom-global` MCP server configured, call the tools directly:

```json
// 1. Send a message/task to another companion
{
  "tool": "intercom_send",
  "arguments": {
    "from": "my-session-name",
    "to": "madhav",
    "message": "Please review the updated Prisma schema in server/prisma/schema.prisma"
  }
}

// 2. Interrupt and auto-wake an agent immediately
{
  "tool": "intercom_wake",
  "arguments": {
    "to": "keshav",
    "message": "Run npm run test:all and report failures"
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

If MCP tools are not directly available, execute the global CLI via terminal:

#### 1. Auto-Wake a Companion Agent
```bash
intercom wake --to <agentName> --msg "<task instructions>"
# Or use the shortcut:
intercom-wake <agentName> "<task instructions>"
```

#### 2. Send a Notification
```bash
intercom send --from <yourName> --to <recipientName> --msg "<message text>"
```

#### 3. Check for Incoming Tasks
```bash
intercom check --agent <yourName>
```

#### 4. Native Pi-Intercom Direct Commands
```bash
# List all active Pi sessions connected via local IPC pipe
intercom pi list

# Send directly into a Pi terminal
intercom pi send --to madhav --msg "Please run the migration"

# Ask a blocking question and wait for reply
intercom pi ask --to keshav --question "Which port is active?"
```

---

## 📋 Best Practices & Etiquette for AI Agents

1. **Prefer `send` for fire-and-forget notifications**: Only use `wake` or `ask` when you are genuinely blocked and need an immediate response or execution turn.
2. **Be Clear & Self-Contained**: Always include file paths, specific function names, and context in your message so the receiving agent can act without asking follow-up questions.
3. **Acknowledge Receipts**: When you receive a task via `intercom check` or `intercom_read`, send a quick confirmation back so the sender knows work is underway.
