# Repository Guidelines for {{PROJECT_NAME}}

This file defines the primary architectural standards, testing workflows, and invariant constraints for the `{{PROJECT_NAME}}` project (v{{PROJECT_VERSION}}, Node {{NODE_MIN_VERSION}}).

## 1. Core Architecture
- **Mesh Entrypoint**: `src/index.js` (Universal Cross-IDE & Cross-Harness Intercom, Interruption & Agent Communication Framework).
- **Daemon & Server**: `src/server.js` serves HTTP/WebSocket API and Fast-Path SSE on `{{DAEMON_URL}}` (port `{{DAEMON_PORT}}`), plus zero-dependency Prometheus metrics (`/metrics`).
- **Discrete Storage Model**: Safe-Path NTFS discrete envelopes (`mesh/inbox/<agent>/<ts>_<uuid>.json`) and Compare-And-Swap directory locks (`mesh/locks/<agent>.lock`) eliminate monolithic write races.
- **MCP Server**: `bin/intercom-mcp.js` (`{{MCP_SERVER_NAME}}`) exposes {{MCP_TOOLS_COUNT}} tools ({{MCP_TOOLS_LIST}}) for Cursor, Claude Desktop, Antigravity, and VS Code.
- **Console Isolation**: Never write unstructured logs or diagnostics to `stdout` during tool execution or MCP communication. All logs must route to `stderr`.

## 2. Clean TUI Guidelines & Anti-Clutter Invariants
- **OpenCode Minimalist Standard**: The default Intercom TUI (`{{CLI_COMMAND}} tui` or `bin/intercom-tui.js`) must prioritize focus, whitespace, and serenity. Avoid dense 5-box grids, heavy ASCII borders, and wall-to-wall text dumping. Limit visible primary panes to 3 at most (e.g., Peer Mailboxes, Stream/Conversation, Quick Compose).
- **Tabbed Hierarchy**: Structure the interface into clean top-level tabs: `[ Inbox ]  [ Channels ]  [ Mesh Health ]  [ Activity ]`. Each tab focuses strictly on its primary workflow.
- **Zen / Focus Mode (`z` / `Z`)**: Users and developers must always have one-key access to strip away KPI metric bars, system status headers, and auxiliary cards down to the bare essentials (pure conversation and compose box).
- **Ergonomics & Readline Line Editing**: All text inputs and search bars must adhere to standard Readline/Emacs cursor shortcuts:
  - `Ctrl+A` / `Home`: Move cursor to start of line.
  - `Ctrl+E` / `End`: Move cursor to end of line.
  - `Ctrl+K`: Kill line from cursor to end.
  - `Ctrl+U`: Clear line from cursor to start.
  - `Ctrl+W`: Delete previous word.
  - `Alt+B` / `Ctrl+Left`: Backward word jump.
  - `Alt+F` / `Ctrl+Right`: Forward word jump.
  - `Alt+D` / `Ctrl+Delete`: Forward word delete.
- **Visual Focus Rings & Clickable Hitboxes**: Active input cards or list rows must render with distinct visual focus rings or contrast highlights. All footer buttons (e.g. `[ ↵ Send ]`, `[ Tab Switch ]`, `[ Esc Back ]`) must expose registered mouse hitboxes.

## 3. Peer Discovery Standards
- **Registry & Mailbox Discovery**: Active peers are discovered dynamically through `mesh/registry/`, active inboxes in `mesh/inbox/`, and heartbeat manifests in `mesh/heartbeats/<agent>.json`.
- **Liveness Heartbeats**: Agents periodically write ephemeral heartbeats containing timestamp, current status (`idle`, `busy`, `waiting`), and active task references. Heartbeats older than 300s are classified as stale.
- **Ephemeral Mailbox Pruning**: Discovery scans must filter out ephemeral testing artifacts (matching `test_`, `tmp_`, `fuzz_`, or numeric PID suffixes) to keep the peer directory clean and actionable.
- **Autonomous Recovery**: Stale locks and orphaned `.tmp` envelope files are safely reclaimed via compare-and-swap TTL recovery without interrupting live agent mailboxes (`{{CLI_COMMAND}} compact`).

## 4. Mesh Communication Patterns
- **Point-to-Point (P2P) Atomic Envelopes**: Direct messages are serialized into immutable JSON envelopes with ISO timestamps, sender identity, recipient ID, correlation ID, and priority headers.
- **Channel Pub/Sub**: Topic broadcasts (`#backend`, `#frontend`, `#devops`) persist under `mesh/channels/<name>/` with atomic file persistence and fanout to listening subscribers.
- **Transactional Zero-Loss Handoffs**: Task transitions follow a two-phase commit: handoff initiation (`mesh/handoffs/<ticketId>.json`), recipient verification & claim, and completion acknowledgement before sender release.
- **Dual-Speed Dispatch**: Fast-Path in-memory SSE delivers events with sub-millisecond latency (≤1ms) to active daemon subscribers, while Safe-Path NTFS guarantees durability even through process restarts.
- **Dead Letter Queue (DLQ)**: Failed message deliveries route automatically to `mesh/dlq/<uuid>.json` with poison-pill isolation, diagnostic error codes, and background exponential retry.

## 5. Test Verification Requirements
Before submitting or landing changes, the test suite must pass with 100% success:
1. `npm test`: Executes all {{TEST_SUITES_COUNT}} unit, integration, and concurrency suites (`{{TESTS_COUNT}}` passing tests).
2. `node --test test/stress-compaction.test.js`: Validates mailbox compaction and temp-file pruning.
3. `node --test test/stress-ntfs-contention.test.js`: Validates real NTFS lock contention.
4. `node --test test/sse-multiclient.test.js`: Validates Server-Sent Events client fanout.
5. `node --test test/live-scraper.test.js`: Validates live registry scraping, parser purification, and markdown hydration.

## 6. Git Discipline
- **Conventional Commits**: Every commit must follow Conventional Commits (e.g., `feat(tui): ...`, `docs(agents): ...`).
- **File Limit**: Commits should touch only relevant files and never exceed 10 files.
- **Clean Working Tree**: Ensure `git status` is clean before and after task execution.
