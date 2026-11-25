# Repository Guidelines for @advance/intercom-global

This file defines the primary architectural standards, testing workflows, and invariant constraints for the `@advance/intercom-global` project (v2.0.0, Node >=18.0.0).

## 1. Core Architecture
- **Mesh Entrypoint**: `src/index.js` (Universal Cross-IDE & Cross-Harness Intercom, Interruption & Agent Communication Framework).
- **Daemon & Server**: `src/core/daemon.js` (`IntercomDaemon`) and `src/core/server.js` unify through `src/routes/router.js`, serving HTTP API, Fast-Path SSE (`/api/intercom/events`), Google A2A (`/.well-known/agent.json`), and zero-dependency Prometheus metrics (`/metrics`) on `http://127.0.0.1:4150` (port `4150`).
- **Discrete Storage Model**: Safe-Path NTFS discrete envelopes (`mesh/inbox/<agent>/<ts>_<uuid>.json`) and Compare-And-Swap directory locks (`mesh/locks/<agent>.lock`) eliminate monolithic write races.
- **MCP Server**: `bin/intercom-mcp.js` (`intercom-global`) exposes 11 tools (send_message, receive_messages, interrupt_agent, get_agent_status, list_agents, intercom_send, intercom_wake, intercom_watch, intercom_read, intercom_clear, intercom_list_peers) for Cursor, Claude Desktop, Antigravity, and VS Code.
- **Console Isolation**: Never write unstructured logs or diagnostics to `stdout` during tool execution or MCP communication. All logs must route to `stderr`.

## 2. Clean TUI Guidelines & Anti-Clutter Invariants
- **OpenCode Minimalist Standard**: The default Intercom TUI (`intercom tui` or `bin/intercom-tui.js`) must prioritize focus, whitespace, and serenity. Avoid dense 5-box grids, heavy ASCII borders, and wall-to-wall text dumping. Keep the right sidebar collapsed by default (`Ctrl+B` / `[ ☰ Menu ]`) and focus the main canvas on a centered composer and conversation stream.
- **Views & Navigation Hierarchy**: `bin/intercom-tui.js` provides clickable Row-1 sub-tabs (`[ ✦ Home ]`, `@peer`, `#channel`, `[ + New ]`) and 7 primary navigation categories in `NAV_TABS` (`Home`, `Inbox`, `Channels`, `Peers`, `Info`, `Settings`, `Help`), plus a dedicated `Activity` stream view (`a` key / `[ Activity ]`).
- **Zen / Focus Mode (`z` / `Z`)**: Users and developers always have one-key access (`z`, `Z`, or `Ctrl+Z`; `Esc` to exit) to strip away top bars, sidebars, and corner stats down to the bare essentials (conversation stream and compose box).
- **Ergonomics & Readline Line Editing**: All text inputs and search bars must adhere to standard Readline/Emacs cursor shortcuts:
  - `Ctrl+A` / `Home`: Move cursor to start of line.
  - `Ctrl+E` / `End`: Move cursor to end of line.
  - `Ctrl+K`: Kill line from cursor to end.
  - `Ctrl+U`: Clear line from cursor to start.
  - `Ctrl+W`: Delete previous word.
  - `Alt+B` / `Ctrl+Left`: Backward word jump.
  - `Alt+F` / `Ctrl+Right`: Forward word jump.
  - `Alt+D` / `Ctrl+Delete`: Forward word delete.
- **Visual Focus Rings & Clickable Hitboxes**: Active input cards or list rows must render with distinct visual focus rings or contrast highlights. All buttons and tabs (e.g. `[ ↵ Send ]`, `[ ☰ Menu ]`, `[ ↻ Refresh ]`, `[ Tab ]` sub-tabs) must expose registered SGR 1006 mouse hitboxes.

## 3. Peer Discovery Standards
- **Registry & Mailbox Discovery**: Active peers are discovered dynamically through `mesh/registry/`, active inboxes in `mesh/inbox/`, and heartbeat manifests in `mesh/heartbeats/<agent>.json`.
- **Liveness Heartbeats**:
  - **Registry State Cards** (`src/core/registry.js`): `listActiveAgents` classifies cards older than `120s` (`staleThresholdMs = 120000`) or with dead PIDs as stale.
  - **Ephemeral Peer Heartbeats** (`HeartbeatRegistry` in `src/core/mesh.js`): `getPeerStatus` / `listLivePeers` use a `30s` live TTL (`ttlMs = 30000`), and `evictStalePeers` defaults to `60s` (`ttlMs = 60000`).
- **Ephemeral Mailbox Pruning**: Discovery scans must filter out ephemeral testing artifacts (matching `test_`, `test-`, `tmp_`, `fuzz_`, `task-`, or numeric PID suffixes) to keep the peer directory clean and actionable.
- **Autonomous Recovery**: Stale locks and orphaned `.tmp` envelope files are safely reclaimed via compare-and-swap TTL recovery without interrupting live agent mailboxes (`intercom compact`).

## 4. Mesh Communication Patterns
- **Point-to-Point (P2P) Atomic Envelopes**: Direct messages are serialized into immutable JSON envelopes with ISO timestamps, sender identity, recipient ID, correlation ID, and priority headers.
- **Channel Pub/Sub**: Topic broadcasts (`#backend`, `#frontend`, `#devops`) persist under `mesh/channels/<name>.json` with atomic file persistence and fanout to listening subscribers.
- **Transactional Zero-Loss Handoffs**: Task transitions follow a two-phase commit: handoff initiation (`mesh/handoffs/<ticketId>.json`), recipient verification & claim, and completion acknowledgement before sender release.
- **Dual-Speed Dispatch**: Fast-Path in-memory SSE delivers events with sub-millisecond latency (<=1ms) to active daemon subscribers, while Safe-Path NTFS guarantees durability even through process restarts.
- **Dead Letter Queue (DLQ)**: Failed message deliveries route automatically to `mesh/dlq/<uuid>.json` with poison-pill isolation, diagnostic error codes, and background exponential retry.

## 5. Documentation Templates & Hydration
- Source templates containing double-brace template variables live under `templates/` (`templates/README.md`, `templates/AGENTS.md`, `templates/docs/*.md`).
- Hydrate committed Markdown outputs via `node scripts/live-scrape-sync.js --offline --hydrate templates/<file> --out <dest>` so committed docs contain zero unresolved template placeholders.

## 6. Test Verification Requirements
Before submitting or landing changes, the test suite must pass with 100% success:
1. `npm test`: Executes all 55 unit, integration, and concurrency suites (`288` passing tests).
2. `node --test test/stress-compaction.test.js`: Validates mailbox compaction and temp-file pruning.
3. `node --test test/stress-ntfs-contention.test.js`: Validates real NTFS lock contention.
4. `node --test test/sse-multiclient.test.js`: Validates Server-Sent Events client fanout.
5. `node --test test/live-scraper.test.js`: Validates live registry scraping, parser purification, and markdown hydration.

## 7. Git Discipline
- **Conventional Commits**: Every commit must follow Conventional Commits (e.g., `feat(tui): ...`, `docs(agents): ...`).
- **File Limit**: Commits should touch only relevant files and never exceed 10 files.
- **Clean Working Tree**: Ensure `git status` is clean before and after task execution.
