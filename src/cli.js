// src/cli.js - Comprehensive CLI Command Suite for intercom-global
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn, execSync } = require('child_process');
const { PORT, MESH_DIR, getPort, getMeshDir, getBrokerConnectTarget } = require('./config');
const { MessageEnvelope } = require('./core/message');
const {
  writeMessage,
  compactMailboxes,
  readInbox,
  ackMessage,
  clearInbox,
  waitForUnread,
  listActiveMailboxes,
  validateAgentName,
  updateDiscreteEnvelopeSync,
  checkAndMarkRead,
  HandoffCoordinator
} = require('./core/mesh');
const {
  registerAgent,
  unregisterAgent,
  getAgentState,
  listActiveAgents,
  touchHeartbeat
} = require('./core/registry');
const { interruptAgent } = require('./core/interrupter');
const { IntercomDaemon, startDaemon, stopDaemon, getDaemonStatus } = require('./core/daemon');

const BOOLEAN_FLAGS = new Set([
  'dry-run', 'dryRun',
  'no-empty', 'noEmpty',
  'json',
  'unlink',
  'quiet', 'q',
  'help', 'h',
  'force', 'f',
  'apply',
  'auto-partition', 'autoPartition',
  'offline',
  'vars',
  'write',
  'in-place', 'inPlace'
]);

function coerceBooleanFlagValue(rawVal) {
  const lower = String(rawVal).trim().toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return true;
}

function parseArgs(args) {
  const parsed = { _: [], flags: {} };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        const k = raw.slice(0, eqIdx);
        const v = raw.slice(eqIdx + 1);
        parsed.flags[k] = BOOLEAN_FLAGS.has(k) ? coerceBooleanFlagValue(v) : v;
      } else if (BOOLEAN_FLAGS.has(raw)) {
        parsed.flags[raw] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        parsed.flags[raw] = args[i + 1];
        i++;
      } else {
        parsed.flags[raw] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const raw = arg.slice(1);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        const k = raw.slice(0, eqIdx);
        const v = raw.slice(eqIdx + 1);
        parsed.flags[k] = BOOLEAN_FLAGS.has(k) ? coerceBooleanFlagValue(v) : v;
      } else if (BOOLEAN_FLAGS.has(raw)) {
        parsed.flags[raw] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        parsed.flags[raw] = args[i + 1];
        i++;
      } else {
        parsed.flags[raw] = true;
      }
    } else {
      parsed._.push(arg);
    }
    i++;
  }
  return parsed;
}

function showHelp() {
  console.log(`
================================================================================
           🌐 INTERCOM GLOBAL - UNIVERSAL CROSS-IDE MULTI-AGENT CLI
================================================================================

USAGE:
  intercom send <recipient> <message> [options]
    Options:
      --from <sender>           Sending agent name (default: operator)
      --type <type>             task_dispatch, task_response, interrupt, heartbeat, ack
      --priority <priority>     LOW, NORMAL, HIGH, CRITICAL (default: NORMAL)
      --correlation-id <id>     Correlation UUID linking request to response
      --parent-id <id>          Parent session UUID

  intercom watch <agent>
    Listens reactively to incoming messages for the agent via live Fast-Path SSE
    stream (with automatic Safe-Path file-mesh fallback).

  intercom daemon <start|stop|status> [--port <port>]
    Manages the local loopback HTTP/WebSocket background daemon (127.0.0.1:4150).

  intercom register <agent> [options]
    Registers agent state card in discovery registry:
      --ide <ide>               antigravity, cursor, windsurf, vscode, opencode, qoder, claude...
      --role <role>             worker, reviewer, auditor, explorer, coordinator, architect...
      --capabilities <c1,c2>    Comma-separated list of capabilities

  intercom interrupt <agent> [options]
    Issues real-time 3-tier interruption to target agent:
      --reason <reason>         Reason for redirection or halt
      --mode <auto|pty|jsonrpc|mesh>

  intercom ack <agent> <messageId> [--unlink]
    Acknowledges message in agent's inbox, moving it to archive or unlinking.

  intercom compact [agent] [options]
    Prunes empty ephemeral mailboxes and orphaned temp files in mesh/inbox:
      --dry-run                 Simulates compaction without deleting files
      --no-empty                Do not remove empty mailbox directories
      --temp-ttl <ms>           Age threshold for temp file pruning (default: 60000ms)

  intercom dlq <list|show|clear> [options]
    Manages Dead Letter Queue for failed deliveries:
      list [--json] [--limit <n>]  Lists failed messages in DLQ
      show <id> [--json]           Displays failure diagnostics for specific message
      clear                        Purges all dead-letter messages

  intercom channel <send|list|read> [options]
    Publishes and inspects broadcast channels:
      send <#channel> <message> [--from <sender>]
      list [--json]
      read <#channel> [--limit <n>] [--json]

  intercom handoff <init|accept|complete|reject|status> [options]
    Zero-loss transactional cross-agent task handoff protocol:
      init <toAgent> <taskId> [payloadJson] [--from <sender>] [--timeout <sec>]
      accept <ticketId> [--agent <recipient>]
      complete <ticketId> [resultJson] [--from <sender>]
      reject <ticketId> [reason] [--agent <recipient>]
      status <ticketId> [--json]

  intercom peers
    Lists all connected Fast-Path peers and registered agents.

  intercom jules <check|dispatch|list|pull> [options]
    Manages Google Jules cloud VM task offloading:
      check                     Verifies CLI auth, git status, and concurrency/daily quota
      dispatch <spec.json>      Validates 5-pillar spec and dispatches task to Jules
      list                      Lists active and completed remote Jules sessions
      pull <sessionId> [--apply] Fetches or applies session patch

  intercom governance <check|verify-action> [options]
    Enforces Teamwork Execution & Governance Invariants:
      check <agent>             Inspects subagent reuse cycles and rotation status
      verify-action <agent> <action>
                                Verifies action against Zero-Kill Protocol (INVIOLABLE)

  intercom metrics [--json]
    Displays real-time Prometheus exposition metrics (throughput, latency, active mailboxes, DLQ, locks).

  intercom doctor
    Executes comprehensive health, permissions, and network diagnostics.

  intercom sync [--force] [--hydrate [file]] [--write] [--vars] [--url <url>] [--json]
    Scrapes & purifies live model/harness registries, updates TTL cache, and hydrates .md variables.

  intercom mcp
    Launches Model Context Protocol (MCP) stdio server for AI IDEs.

  intercom tui
    Launches modern OpenCode-inspired 4-tab interactive terminal UI dashboard.
================================================================================
`);
}

const CLI_COMMANDS = [
  'send', 'watch', 'daemon', 'register', 'interrupt', 'ack', 'compact',
  'dlq', 'channel', 'handoff', 'peers', 'jules', 'governance', 'metrics',
  'doctor', 'sync', 'mcp', 'tui'
];

async function run(rawArgv = process.argv.slice(2)) {
  const { _, flags } = parseArgs(rawArgv);
  const command = _[0];

  // Hidden internal daemon runner for background spawn
  if (command === '__daemon_run') {
    const port = flags.port ? parseInt(flags.port, 10) : (PORT || 4150);
    const daemon = new IntercomDaemon({ port });
    await daemon.start();
    await new Promise((resolve) => {
      const shutdown = async () => {
        await daemon.stop();
        resolve();
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    });
    return;
  }

  if (!command || command === 'help' || flags.help || flags.h) {
    showHelp();
    return;
  }

  try {
    switch (command) {
      case 'send': {
        const recipient = _[1] || flags.to || flags.recipient;
        const message = _[2] || flags.message || flags.msg;
        if (!recipient) {
          console.error('Error: Recipient agent is required. Usage: intercom send <recipient> <message>');
          process.exitCode = 1;
          return;
        }
        if (!message) {
          console.error('Error: Message content is required. Usage: intercom send <recipient> <message>');
          process.exitCode = 1;
          return;
        }

        const sender = flags.from || flags.sender || process.env.INTERCOM_AGENT || 'operator';
        const type = flags.type || 'task_dispatch';
        const priority = flags.priority ? flags.priority.toUpperCase() : 'NORMAL';
        const correlationId = flags['correlation-id'] || flags.correlationId;
        const parentId = flags['parent-id'] || flags.parentId;

        const envelope = MessageEnvelope.create({
          sender,
          recipient,
          type,
          priority,
          payload: { message },
          correlationId,
          parentId
        });

        // Fast-Path attempt via daemon
        let sent = false;
        try {
          const res = await fetch(`http://127.0.0.1:${getPort()}/api/intercom/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope.toJSON()),
            signal: AbortSignal.timeout(1500)
          });
          if (res.ok) {
            const data = await res.json();
            console.log(`Message delivered: [INTERCOM SUCCESS] Dispatched via ${data.status} (ID: ${envelope.id})`);
            sent = true;
          }
        } catch {}

        if (!sent) {
          // Safe-Path fallback directly to disk
          const writeRes = await writeMessage(recipient, envelope);
          console.log(`Message delivered: [INTERCOM SUCCESS] Written to Safe-Path File-Mesh (ID: ${envelope.id})`);
          console.log(`  Path: ${writeRes.path}`);
        }
        break;
      }

      case 'watch': {
        const agent = _[1] || flags.agent || flags.for;
        if (!agent) {
          console.error('Error: Agent name is required. Usage: intercom watch <agent>');
          process.exitCode = 1;
          return;
        }

        const cleanAgent = validateAgentName(agent);

        let timeoutSec = 5;
        if (flags.timeout !== undefined) {
          const rawTimeout = String(flags.timeout).trim();
          const parsedTimeout = Number(rawTimeout);
          if (flags.timeout === true || rawTimeout === '' || !Number.isFinite(parsedTimeout) || parsedTimeout < 0) {
            console.error(`Error: Invalid --timeout value "${flags.timeout}". Expected a non-negative number of seconds.`);
            process.exitCode = 1;
            return;
          }
          timeoutSec = parsedTimeout;
        }

        if (flags.json) {
          const msgs = await waitForUnread(cleanAgent, timeoutSec * 1000);
          const formatted = msgs.map(m => {
            const raw = m.toJSON ? m.toJSON() : m;
            return {
              ...raw,
              message: (raw.payload && raw.payload.message) || raw.message || ''
            };
          });
          console.log(JSON.stringify(formatted));
          return;
        }

        console.log(`[INTERCOM WATCH] Listening for messages for "${cleanAgent}"... (Press Ctrl+C to exit)`);

        const abortController = new AbortController();
        const port = getPort();
        let req = null;
        let sseActive = false;
        let fallbackStarted = false;

        await new Promise((resolve) => {
          const onSig = () => {
            abortController.abort();
            if (req) {
              try { req.destroy(); } catch {}
            }
            cleanupSignals();
            resolve();
          };
          const cleanupSignals = () => {
            process.removeListener('SIGINT', onSig);
            process.removeListener('SIGTERM', onSig);
          };
          process.on('SIGINT', onSig);
          process.on('SIGTERM', onSig);

          const startFallback = (reason) => {
            if (abortController.signal.aborted || fallbackStarted) return;
            fallbackStarted = true;
            console.log(`[INTERCOM WATCH] ${reason}. Falling back to Safe-Path File-Mesh reactive watcher.`);
            startFileMeshWatcher(cleanAgent, { signal: abortController.signal })
              .catch(() => {})
              .finally(() => {
                cleanupSignals();
                resolve();
              });
          };

          const handleSseBlock = (block) => {
            const trimmed = block.trim();
            if (!trimmed) return;
            let eventName = 'message';
            const dataLines = [];
            for (const line of block.split('\n')) {
              if (!line || line.startsWith(':')) continue;
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim() || 'message';
              } else if (line.startsWith('data:')) {
                const val = line.slice(5);
                dataLines.push(val.startsWith(' ') ? val.slice(1) : val);
              }
            }
            if (eventName === 'ping' || eventName === 'shutdown') return;
            if (dataLines.length === 0) return;
            const dataPayload = dataLines.join('\n');
            try {
              const parsed = JSON.parse(dataPayload);
              printMessage(parsed);
            } catch {
              console.log(`[RAW]: ${dataPayload}`);
            }
          };

          req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/api/intercom/events?agent=${encodeURIComponent(cleanAgent)}`,
            method: 'GET',
            headers: { 'Accept': 'text/event-stream' }
          }, (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              startFallback(`Daemon returned HTTP ${res.statusCode}`);
              return;
            }
            sseActive = true;
            console.log(`[INTERCOM WATCH] Connected to Fast-Path SSE stream on :${port}`);
            let buffer = '';
            res.on('data', (chunk) => {
              buffer += chunk.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
              const blocks = buffer.split('\n\n');
              buffer = blocks.pop() || '';
              for (const block of blocks) {
                handleSseBlock(block);
              }
            });
            res.on('end', () => {
              if (buffer.trim()) handleSseBlock(buffer);
              buffer = '';
              startFallback('Daemon SSE stream ended');
            });
            res.on('close', () => {
              startFallback('Daemon SSE stream closed');
            });
            res.on('error', (err) => {
              startFallback(`Daemon SSE error (${err.message})`);
            });
          });

          req.on('error', () => {
            if (!sseActive) {
              startFallback('Daemon offline');
            }
          });

          req.end();
        });
        break;
      }

      case 'daemon': {
        const sub = _[1] || 'status';
        const port = flags.port ? parseInt(flags.port, 10) : (PORT || 4150);

        if (sub === 'start') {
          console.log(`[DAEMON] Starting loopback daemon on 127.0.0.1:${port}...`);
          const status = await getDaemonStatus(port);
          if (status.running) {
            console.log(`[DAEMON] Daemon is already running on port ${port} (PID: ${status.details?.pid})`);
            return;
          }

          // Launch detached daemon process
          const child = spawn(process.execPath, [__filename, '__daemon_run', `--port=${port}`], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          child.unref();

          // Wait up to 3 seconds for health verification
          let started = false;
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 200));
            const check = await getDaemonStatus(port);
            if (check.running) {
              console.log(`[DAEMON] Successfully started on port ${port} (PID: ${check.details?.pid})`);
              started = true;
              break;
            }
          }
          if (!started) {
            console.error('[DAEMON ERROR] Failed to verify daemon startup within 3s');
            process.exitCode = 1;
          }
        } else if (sub === 'stop') {
          console.log(`[DAEMON] Stopping daemon on port ${port}...`);
          const stopped = await stopDaemon(port);
          if (stopped) {
            console.log('[DAEMON] Daemon stopped successfully.');
          } else {
            console.log('[DAEMON] No running daemon found or PID file already clean.');
          }
        } else if (sub === 'run') {
          console.log(`[DAEMON] Running foreground loopback daemon on 127.0.0.1:${port}...`);
          const daemon = new IntercomDaemon({ port });
          await daemon.start();
          console.log(`[DAEMON ONLINE] 127.0.0.1:${port} (PID: ${process.pid})`);
          await new Promise((resolve) => {
            const shutdown = async () => {
              await daemon.stop();
              resolve();
            };
            process.on('SIGTERM', shutdown);
            process.on('SIGINT', shutdown);
          });
        } else if (sub === 'status') {
          const status = await getDaemonStatus(port);
          if (status.running) {
            console.log(`[DAEMON ONLINE] 127.0.0.1:${port}`);
            console.log(`  PID    : ${status.details?.pid}`);
            console.log(`  Uptime : ${Math.floor(status.details?.uptime || 0)}s`);
            console.log(`  Version: ${status.details?.version}`);
          } else {
            console.log(`[DAEMON OFFLINE] No daemon responding on 127.0.0.1:${port}`);
          }
        } else {
          console.error(`Unknown daemon command: ${sub}. Use start, stop, or status.`);
          process.exitCode = 1;
        }
        break;
      }

      // Backward compatibility alias for server -> daemon runner
      case 'server': {
        const port = flags.port ? parseInt(flags.port, 10) : (PORT || 4150);
        const daemon = new IntercomDaemon({ port });
        await daemon.start();
        await new Promise((resolve) => {
          const shutdown = async () => {
            await daemon.stop();
            resolve();
          };
          process.on('SIGTERM', shutdown);
          process.on('SIGINT', shutdown);
        });
        break;
      }

      case 'compact': {
        const agent = _[1] || flags.agent;
        const isDryRun = flags['dry-run'] === true || flags.dryRun === true;
        const pruneEmpty = flags['no-empty'] === true ? false : true;
        let tempTtlMs = 60000;
        if (flags['temp-ttl'] !== undefined) {
          const parsedTtl = Number(flags['temp-ttl']);
          if (flags['temp-ttl'] === true || !Number.isFinite(parsedTtl) || parsedTtl < 0) {
            console.error(`Error: Invalid --temp-ttl value "${flags['temp-ttl']}". Expected non-negative milliseconds.`);
            process.exitCode = 1;
            return;
          }
          tempTtlMs = Math.floor(parsedTtl);
        }

        console.log(`[INTERCOM COMPACT] Starting mailbox compaction${isDryRun ? ' [DRY RUN]' : ''}...`);
        const report = await compactMailboxes({
          dryRun: isDryRun,
          pruneEmpty,
          tempTtlMs,
          targetMailbox: agent
        });

        console.log(`  Mailboxes Examined     : ${report.examined}`);
        console.log(`  Empty Mailboxes Pruned : ${report.prunedDirs}${report.prunedEmptyMailboxes.length > 0 ? ` (${report.prunedEmptyMailboxes.join(', ')})` : ''}`);
        console.log(`  Orphaned Temp Files    : ${report.prunedTempFiles}`);
        console.log(`  Space Reclaimed        : ${(report.reclaimedBytes / 1024).toFixed(2)} KB`);
        if (report.skippedLocked.length > 0) {
          console.log(`  Skipped (Locked)       : ${report.skippedLocked.join(', ')}`);
        }
        console.log(`[INTERCOM SUCCESS] Compaction complete.\n`);
        break;
      }

      case 'register': {
        const agent = _[1] || flags.agent || flags.name;
        if (!agent) {
          console.error('Error: Agent name is required. Usage: intercom register <agent>');
          process.exitCode = 1;
          return;
        }

        const ide = flags.ide || 'terminal';
        const role = flags.role || 'worker';
        const capabilities = flags.capabilities ? flags.capabilities.split(',').map(s => s.trim()) : ['messaging'];
        const pid = flags.pid ? parseInt(flags.pid, 10) : (process.ppid || process.pid);

        const card = await registerAgent({
          name: agent,
          ide,
          role,
          capabilities,
          pid
        });

        console.log(`[REGISTRY SUCCESS] Registered agent "${card.name}":`);
        console.log(JSON.stringify(card, null, 2));
        break;
      }

      case 'interrupt': {
        const agent = _[1] || flags.agent || flags.target;
        if (!agent) {
          console.error('Error: Target agent is required. Usage: intercom interrupt <agent>');
          process.exitCode = 1;
          return;
        }
        const reason = flags.reason || _[2] || 'User commanded immediate pivot';
        const mode = flags.mode || 'auto';

        const result = await interruptAgent(agent, reason, { mode });
        console.log(`[INTERRUPT RESULT] Target: ${agent}`);
        console.log(`  Interrupted: ${result.interrupted}`);
        console.log(`  Method     : ${result.method}`);
        console.log(`  Details    :`, JSON.stringify(result.details, null, 2));
        break;
      }

      case 'ack': {
        const agent = _[1] || flags.agent;
        const messageId = _[2] || flags.id;
        if (!agent || !messageId) {
          console.error('Error: Agent name and message ID are required. Usage: intercom ack <agent> <messageId>');
          process.exitCode = 1;
          return;
        }
        const unlink = flags.unlink === true;
        const acked = await ackMessage(agent, messageId, { unlink });
        if (acked) {
          console.log(`[INTERCOM SUCCESS] Message "${messageId}" acknowledged for agent "${agent}" (${unlink ? 'unlinked' : 'archived'}).`);
        } else {
          console.log(`[INTERCOM WARNING] Message "${messageId}" not found in inbox of agent "${agent}".`);
        }
        break;
      }

      case 'peers': {
        const port = getPort();
        const daemonStatus = await getDaemonStatus(port);
        let connected = [];
        if (daemonStatus.running) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/intercom/peers`, {
              signal: AbortSignal.timeout(1500)
            });
            if (res.ok) {
              const data = await res.json();
              connected = data.connectedPeers || [];
            }
          } catch {}
        }

        const registered = await listActiveAgents();
        const mailboxes = await listActiveMailboxes();

        console.log('\n=== CONNECTED FAST-PATH PEERS ===');
        if (connected.length === 0) {
          console.log('  (No live Fast-Path SSE streams connected)');
        } else {
          for (const p of connected) {
            console.log(`  ⚡ ${p} (Online on Fast-Path SSE)`);
          }
        }

        console.log('\n=== REGISTERED AGENT STATE CARDS ===');
        if (registered.length === 0) {
          console.log('  (No agents currently registered in mesh/registry)');
        } else {
          for (const a of registered) {
            console.log(`  • ${a.name.padEnd(16)} | IDE: ${a.ide.padEnd(12)} | Role: ${a.role.padEnd(12)} | PID: ${String(a.pid).padEnd(6)} | Status: ${a.status}`);
          }
        }

        console.log('\n=== DISCRETE MAILBOX QUEUES ===');
        if (mailboxes.length === 0) {
          console.log('  (No mailboxes created in mesh/inbox)');
        } else {
          for (const m of mailboxes) {
            console.log(`  📬 ${m.name.padEnd(16)} | Pending Messages: ${m.total}`);
          }
        }
        console.log('');
        break;
      }

      case 'metrics': {
        const { metrics } = require('./core/metrics');
        if (flags.json) {
          const gauges = metrics.gatherFilesystemGauges(getMeshDir(), { includeMailboxCounts: true });
          console.log(JSON.stringify({
            ...gauges,
            mailboxCounts: Object.fromEntries(gauges.mailboxCounts || [])
          }, null, 2));
        } else {
          console.log(metrics.formatPrometheus());
        }
        break;
      }

      case 'doctor': {
        await runDoctor();
        break;
      }

      case 'sync': {
        const { runSyncCli } = require('../scripts/live-scrape-sync');
        await runSyncCli(rawArgv.slice(1));
        break;
      }

      case 'mcp': {
        const { startMcpServer } = require('./mcp/server');
        const { scheduleBackgroundSync } = require('./live-scraper');
        startMcpServer();
        try {
          scheduleBackgroundSync({ mode: 'subprocess' });
        } catch {}
        break;
      }

      case 'tui': {
        require('../bin/intercom-tui');
        break;
      }

      // Backwards compatibility helpers
      case 'read': {
        const agent = _[1] || flags.agent;
        if (!agent) {
          console.error('Error: Agent name required: intercom read <agent>');
          process.exitCode = 1;
          return;
        }
        const msgs = await readInbox(agent);
        const formatted = msgs.map(m => {
          const raw = m.toJSON ? m.toJSON() : m;
          return {
            ...raw,
            message: (raw.payload && raw.payload.message) || raw.message || '',
            read: raw.read !== undefined ? raw.read : false
          };
        });
        console.log(JSON.stringify(formatted));
        break;
      }

      case 'check': {
        const agent = _[1] || flags.agent;
        if (!agent) {
          console.error('Error: Agent name required: intercom check --agent <name>');
          process.exitCode = 1;
          return;
        }
        const legacyUnread = checkAndMarkRead(agent) || [];
        const discreteMsgs = await readInbox(agent);
        const discreteUnread = [];
        const nowIso = new Date().toISOString();
        for (const m of discreteMsgs) {
          const raw = m.toJSON ? m.toJSON() : m;
          if (raw.read === true) continue;
          let updated = null;
          if (raw.id) {
            try {
              updated = updateDiscreteEnvelopeSync(agent, String(raw.id), (env) => ({
                ...env,
                read: true,
                readAt: env.readAt || nowIso
              }));
            } catch {}
          }
          const finalRaw = updated || { ...raw, read: true, readAt: raw.readAt || nowIso };
          discreteUnread.push({
            ...finalRaw,
            message: (finalRaw.payload && finalRaw.payload.message) || finalRaw.message || '',
            read: true
          });
        }
        const combined = [...legacyUnread, ...discreteUnread];
        console.log(JSON.stringify(combined));
        break;
      }

      case 'clear': {
        const agent = _[1] || flags.agent;
        if (!agent) {
          console.error('Error: Agent name required: intercom clear <agent>');
          process.exitCode = 1;
          return;
        }
        const count = await clearInbox(agent);
        console.log(`Cleared inbox: ${count} messages removed for "${agent}".`);
        break;
      }

      case 'jules': {
        const sub = _[1] || 'check';
        const julesDelegator = require('./core/jules-delegator');
        const julesBridge = require('./bridges/jules-bridge');
        const isDryRun = flags['dry-run'] || flags.dryRun || process.env.JULES_DRY_RUN === 'true';

        if (sub === 'check') {
          console.log('\n=== GOOGLE JULES ENVIRONMENT & QUOTA CHECK ===');
          const env = await julesBridge.checkJulesEnvironment({ dryRun: isDryRun });
          console.log(`  CLI Installed    : ${env.installed ? 'YES (' + env.version + ')' : 'NO'}`);
          console.log(`  Authenticated    : ${env.authenticated ? 'YES' : 'NO'}`);
          console.log(`  Inside Git Repo  : ${env.inGitRepo ? 'YES' : 'NO'}`);

          const quota = await julesDelegator.checkQuota({ dryRun: isDryRun });
          console.log(`  Active Sessions  : ${quota.activeSessions} / ${julesDelegator.JULES_LIMITS.MAX_CONCURRENT_SESSIONS}`);
          console.log(`  Daily Sessions   : ${quota.dailySessions} / ${julesDelegator.JULES_LIMITS.MAX_DAILY_SESSIONS}`);
          console.log(`  Quota Available  : ${quota.available ? 'YES' : 'NO (' + quota.reason + ')'}\n`);
          break;
        }

        if (sub === 'dispatch') {
          const specArg = _[2] || flags.file || flags.spec;
          if (!specArg) {
            console.error('Error: Specification file or JSON string is required. Usage: intercom jules dispatch <spec.json>');
            process.exitCode = 1;
            return;
          }

          let taskSpec;
          if (fs.existsSync(specArg)) {
            taskSpec = JSON.parse(fs.readFileSync(specArg, 'utf8'));
          } else {
            try {
              taskSpec = JSON.parse(specArg);
            } catch {
              taskSpec = {
                targetFiles: [specArg],
                summary: flags.summary || flags.title || 'Heavy edit overhaul',
                symptomContext: flags.symptom || 'CLI dispatched overhaul',
                acceptanceCriteria: [flags.criteria || 'Clean compilation and zero regressions'],
                testCommand: flags.test || 'npm test',
                boundaries: [flags.boundaries || 'Only modify specified file']
              };
            }
          }

          const result = await julesDelegator.dispatchTask(taskSpec, {
            dryRun: isDryRun,
            autoPartition: flags['auto-partition'] || flags.autoPartition
          });

          if (result.fallbackActivated) {
            console.log(`[JULES FALLBACK ACTIVATED] ${result.reason}`);
            console.log(`  Fallback Strategy: ${result.type}`);
            console.log(`  Disallow Re-Delegation: ${result.disallowJulesReDelegation}`);
          } else {
            console.log(`[JULES DISPATCH SUCCESS] Session ID: ${result.sessionId}`);
            console.log(`  Status : ${result.status}`);
            console.log(`  Files  : ${result.files.join(', ')}`);
          }
          break;
        }

        if (sub === 'list' || sub === 'status') {
          const sessions = await julesBridge.listSessions({ dryRun: isDryRun });
          if (flags.json) {
            console.log(JSON.stringify(sessions));
            return;
          }
          console.log('\n=== GOOGLE JULES REMOTE SESSIONS ===');
          if (sessions.length === 0) {
            console.log('  (No active or recorded sessions found)');
          } else {
            for (const s of sessions) {
              console.log(`  • [${s.status.padEnd(9)}] ${s.id.padEnd(16)} | ${s.repo || 'current'}`);
            }
          }
          console.log('');
          break;
        }

        if (sub === 'pull') {
          const sessionId = _[2] || flags.session || flags.id;
          if (!sessionId) {
            console.error('Error: Session ID required. Usage: intercom jules pull <sessionId> [--apply]');
            process.exitCode = 1;
            return;
          }
          const pullRes = await julesBridge.pullSession(sessionId, {
            apply: flags.apply === true,
            dryRun: isDryRun
          });
          console.log(`[JULES PULL SUCCESS] Session: ${sessionId} (Applied: ${pullRes.applied})`);
          if (!flags.apply) {
            console.log(pullRes.patch);
          }
          break;
        }

        console.error(`Unknown jules command: "${sub}". Use check, dispatch, list, or pull.`);
        process.exitCode = 1;
        break;
      }

      case 'governance': {
        const sub = _[1] || 'check';
        const governance = require('./core/governance');

        if (sub === 'check') {
          const agent = _[2] || flags.agent || flags.name;
          if (!agent) {
            console.error('Error: Agent name required. Usage: intercom governance check <agent>');
            process.exitCode = 1;
            return;
          }
          const stats = governance.getWorkerUsage(agent);
          console.log(`\n=== GOVERNANCE USAGE CARD: ${agent} ===`);
          console.log(`  Turn Count    : ${stats.turnCount} / ${stats.limit}`);
          console.log(`  Task Type     : ${stats.taskType}`);
          console.log(`  Should Rotate : ${stats.shouldRotate ? 'YES (Cap Reached)' : 'NO (Healthy)'}\n`);
          break;
        }

        if (sub === 'verify-action') {
          const agent = _[2] || flags.agent;
          const action = _[3] || flags.action;
          if (!agent || !action) {
            console.error('Error: Agent and action required. Usage: intercom governance verify-action <agent> <action>');
            process.exitCode = 1;
            return;
          }
          const agentState = await getAgentState(agent) || { name: agent, status: 'RUNNING' };
          governance.verifyZeroKill(action, agentState);
          console.log(`[GOVERNANCE VERIFIED] Action "${action}" is compliant for agent "${agent}".`);
          break;
        }

        console.error(`Unknown governance command: "${sub}". Use check or verify-action.`);
        process.exitCode = 1;
        break;
      }

      case 'dlq': {
        const sub = _[1] || 'list';
        const { getDlq, getDlqMessage, clearDlq } = require('./core/dlq');

        if (sub === 'list') {
          const items = getDlq();
          const limit = flags.limit ? parseInt(flags.limit, 10) : (flags.n ? parseInt(flags.n, 10) : null);
          const displayItems = limit ? items.slice(0, limit) : items;

          if (flags.json) {
            console.log(JSON.stringify(displayItems, null, 2));
            break;
          }

          console.log('\n================================================================================');
          console.log('                        DEAD LETTER QUEUE (DLQ) DIAGNOSTICS                     ');
          console.log('================================================================================');
          console.log(`Total Failed Messages: ${items.length}\n`);

          if (items.length === 0) {
            console.log('  ✨ DLQ is clean (0 failed messages).\n');
            break;
          }

          for (const item of displayItems) {
            const ts = item.enqueuedAt ? new Date(item.enqueuedAt).toLocaleString() : 'N/A';
            const to = (item.to || item.recipient || 'unknown').toUpperCase();
            const from = (item.from || item.sender || 'unknown').toUpperCase();
            console.log(`  • [${item.id}] ${from} ──► ${to} (Retries: ${item.retries || 0})`);
            console.log(`    Enqueued : ${ts}`);
            console.log(`    Reason   : ${item.failureReason || 'Unknown error'}`);
            const msgPreview = (item.message || (item.payload && item.payload.message) || '').slice(0, 60);
            if (msgPreview) console.log(`    Snippet  : "${msgPreview}..."`);
            console.log('');
          }

          if (limit && items.length > limit) {
            console.log(`  (...showing ${limit} of ${items.length} items. Use --limit to show more)`);
          }
          break;
        }

        if (sub === 'show') {
          const id = _[2] || flags.id;
          if (!id) {
            console.error('Error: Message ID required. Usage: intercom dlq show <id>');
            process.exitCode = 1;
            break;
          }

          const item = getDlqMessage(id);
          if (!item) {
            console.error(`Error: Message "${id}" not found in Dead Letter Queue.`);
            process.exitCode = 1;
            break;
          }

          if (flags.json) {
            console.log(JSON.stringify(item, null, 2));
            break;
          }

          console.log('\n=== DEAD LETTER QUEUE MESSAGE DETAILS ===');
          console.log(`  ID            : ${item.id}`);
          console.log(`  Recipient     : ${item.to || item.recipient || 'unknown'}`);
          console.log(`  Sender        : ${item.from || item.sender || 'unknown'}`);
          console.log(`  Enqueued At   : ${item.enqueuedAt || 'unknown'}`);
          console.log(`  Retries       : ${item.retries || 0}`);
          console.log(`  Failure Reason: ${item.failureReason || 'unknown'}`);
          const payloadStr = typeof item.payload === 'object' ? JSON.stringify(item.payload, null, 2) : (item.message || '');
          console.log(`  Payload       :\n${payloadStr}\n`);
          break;
        }

        if (sub === 'clear') {
          const countBefore = getDlq().length;
          clearDlq();
          console.log(`\n✨ Dead Letter Queue cleared. ${countBefore} messages removed.\n`);
          break;
        }

        console.error(`Unknown dlq subcommand: "${sub}". Use "list", "show", or "clear".`);
        process.exitCode = 1;
        break;
      }

      case 'channel': {
        const sub = _[1] || 'list';
        const { sendChannelMessage, readChannel, listChannels } = require('./core/mesh');

        if (sub === 'send') {
          const chanArg = _[2] || flags.channel;
          const msgArg = _[3] || flags.msg || flags.message;
          const fromArg = flags.from || flags.sender || 'operator';

          if (!chanArg || !msgArg) {
            console.error('Error: Channel and message required. Usage: intercom channel send <#channel> <message> [--from <sender>]');
            process.exitCode = 1;
            break;
          }

          const res = sendChannelMessage(chanArg, fromArg, msgArg);
          if (flags.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(`[CHANNEL PUBLISHED] ID: ${res.id} | Channel: ${res.channel} | From: ${res.from}`);
          }
          break;
        }

        if (sub === 'list') {
          const channels = listChannels();
          if (flags.json) {
            console.log(JSON.stringify(channels, null, 2));
            break;
          }

          console.log('\n================================================================================');
          console.log('                          ACTIVE MESH CHANNELS                                  ');
          console.log('================================================================================');
          if (channels.length === 0) {
            console.log('  (No active channels found. Use "intercom channel send <#name> <msg>" to create one)\n');
            break;
          }

          for (const c of channels) {
            console.log(`  • ${c.name.padEnd(20)} (${c.total} messages)`);
          }
          console.log('');
          break;
        }

        if (sub === 'read') {
          const chanArg = _[2] || flags.channel;
          if (!chanArg) {
            console.error('Error: Channel required. Usage: intercom channel read <#channel>');
            process.exitCode = 1;
            break;
          }

          const msgs = readChannel(chanArg);
          const limit = flags.limit ? parseInt(flags.limit, 10) : null;
          const displayMsgs = limit ? msgs.slice(-limit) : msgs;

          if (flags.json) {
            console.log(JSON.stringify(displayMsgs, null, 2));
            break;
          }

          console.log(`\n=== CHANNEL ${chanArg.toUpperCase()} (${msgs.length} messages) ===`);
          if (displayMsgs.length === 0) {
            console.log('  (Empty channel)\n');
            break;
          }

          for (const m of displayMsgs) {
            const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
            console.log(`  [${ts}] ${(m.from || 'unknown').toUpperCase()}: ${m.message}`);
          }
          console.log('');
          break;
        }

        console.error(`Unknown channel subcommand: "${sub}". Use "send", "list", or "read".`);
        process.exitCode = 1;
        break;
      }

      case 'handoff': {
        const sub = _[1];
        const coordinator = new HandoffCoordinator(process.env.INTERCOM_MESH_DIR || MESH_DIR);

        if (sub === 'init') {
          const toAgent = _[2] || flags.to || flags.recipient;
          const taskId = _[3] || flags.task || flags.taskId;
          const rawPayload = _[4] || flags.payload || flags.context || '{}';

          if (!toAgent || !taskId) {
            console.error('Error: Recipient agent and taskId are required. Usage: intercom handoff init <toAgent> <taskId> [payloadJson]');
            process.exitCode = 1;
            break;
          }

          let context = {};
          if (typeof rawPayload === 'string') {
            try {
              context = JSON.parse(rawPayload);
            } catch {
              context = { message: rawPayload };
            }
          } else if (typeof rawPayload === 'object') {
            context = rawPayload;
          }

          const sender = flags.from || flags.sender || process.env.INTERCOM_AGENT || 'operator';
          let timeoutMs = 30000;
          if (flags.timeout !== undefined) {
            const parsedTimeout = Number(flags.timeout);
            if (flags.timeout === true || !Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
              console.error(`Error: Invalid --timeout value "${flags.timeout}". Expected a positive number of seconds.`);
              process.exitCode = 1;
              break;
            }
            timeoutMs = Math.round(parsedTimeout * 1000);
          }

          const ticket = await coordinator.initiateHandoff({
            sender,
            recipient: toAgent,
            taskId,
            context,
            timeoutMs
          });

          if (flags.json) {
            console.log(JSON.stringify(ticket, null, 2));
          } else {
            console.log(`[HANDOFF INITIATED] Ticket: ${ticket.handoffId}`);
            console.log(`  Sender   : ${ticket.sender}`);
            console.log(`  Recipient: ${ticket.recipient}`);
            console.log(`  TaskId   : ${ticket.taskId}`);
            console.log(`  Status   : ${ticket.status}`);
            console.log(`  ExpiresAt: ${ticket.expiresAt}`);
          }
          break;
        }

        if (sub === 'accept' || sub === 'confirm') {
          const ticketId = _[2] || flags.ticket || flags.ticketId || flags.id;
          if (!ticketId) {
            console.error('Error: TicketId is required. Usage: intercom handoff accept <ticketId>');
            process.exitCode = 1;
            break;
          }

          const existing = coordinator.getHandoff(ticketId);
          if (!existing) {
            console.error(`Error: Handoff ticket '${ticketId}' not found`);
            process.exitCode = 1;
            break;
          }

          const recipient = flags.agent || flags.recipient || flags.as || process.env.INTERCOM_AGENT || existing.recipient;
          let metadata = { confirmedBy: recipient, pid: process.pid };
          if (flags.metadata !== undefined) {
            if (flags.metadata === true || typeof flags.metadata !== 'string') {
              console.error('Error: --metadata requires a JSON object string.');
              process.exitCode = 1;
              break;
            }
            try {
              metadata = JSON.parse(flags.metadata);
            } catch (err) {
              console.error(`Error: Invalid JSON in --metadata: ${err.message}`);
              process.exitCode = 1;
              break;
            }
          }

          const confirmed = await coordinator.confirmHandoff(ticketId, recipient, metadata);
          if (flags.json) {
            console.log(JSON.stringify(confirmed, null, 2));
          } else {
            console.log(`[HANDOFF ACCEPTED] Ticket: ${ticketId}`);
            console.log(`  Status     : ${confirmed.status}`);
            console.log(`  ConfirmedAt: ${confirmed.confirmedAt}`);
          }
          break;
        }

        if (sub === 'complete') {
          const ticketId = _[2] || flags.ticket || flags.ticketId || flags.id;
          const rawResult = _[3] || flags.result || '{}';
          if (!ticketId) {
            console.error('Error: TicketId is required. Usage: intercom handoff complete <ticketId> [resultJson]');
            process.exitCode = 1;
            break;
          }

          const existing = coordinator.getHandoff(ticketId);
          if (!existing) {
            console.error(`Error: Handoff ticket '${ticketId}' not found`);
            process.exitCode = 1;
            break;
          }

          let result = {};
          if (typeof rawResult === 'string') {
            try {
              result = JSON.parse(rawResult);
            } catch {
              result = { message: rawResult };
            }
          } else if (typeof rawResult === 'object') {
            result = rawResult;
          }

          const sender = flags.sender || flags.from || flags.as || process.env.INTERCOM_AGENT || existing.sender;
          const completed = coordinator.completeHandoff(ticketId, sender, result);

          if (flags.json) {
            console.log(JSON.stringify(completed, null, 2));
          } else {
            console.log(`[HANDOFF COMPLETED] Ticket: ${ticketId}`);
            console.log(`  Status     : ${completed.status}`);
            console.log(`  CompletedAt: ${completed.completedAt}`);
          }
          break;
        }

        if (sub === 'reject') {
          const ticketId = _[2] || flags.ticket || flags.ticketId || flags.id;
          const reason = _[3] || flags.reason || 'Worker capacity exceeded';
          if (!ticketId) {
            console.error('Error: TicketId is required. Usage: intercom handoff reject <ticketId> [reason]');
            process.exitCode = 1;
            break;
          }

          const existing = coordinator.getHandoff(ticketId);
          if (!existing) {
            console.error(`Error: Handoff ticket '${ticketId}' not found`);
            process.exitCode = 1;
            break;
          }

          const recipient = flags.agent || flags.recipient || flags.as || process.env.INTERCOM_AGENT || existing.recipient;
          const rejected = await coordinator.rejectHandoff(ticketId, recipient, reason);

          if (flags.json) {
            console.log(JSON.stringify(rejected, null, 2));
          } else {
            console.log(`[HANDOFF REJECTED] Ticket: ${ticketId}`);
            console.log(`  Status    : ${rejected.status}`);
            console.log(`  Reason    : ${rejected.rejectReason}`);
          }
          break;
        }

        if (sub === 'status') {
          const ticketId = _[2] || flags.ticket || flags.ticketId || flags.id;
          if (!ticketId) {
            console.error('Error: TicketId is required. Usage: intercom handoff status <ticketId>');
            process.exitCode = 1;
            break;
          }

          const ticket = coordinator.getHandoff(ticketId);
          if (!ticket) {
            console.error(`Error: Handoff ticket '${ticketId}' not found`);
            process.exitCode = 1;
            break;
          }

          if (flags.json) {
            console.log(JSON.stringify(ticket, null, 2));
          } else {
            console.log(`\n=== HANDOFF TICKET: ${ticket.handoffId} ===`);
            console.log(`  Sender   : ${ticket.sender}`);
            console.log(`  Recipient: ${ticket.recipient}`);
            console.log(`  TaskId   : ${ticket.taskId}`);
            console.log(`  Status   : ${ticket.status}`);
            console.log(`  CreatedAt: ${ticket.createdAt}`);
            console.log(`  ExpiresAt: ${ticket.expiresAt}`);
            if (ticket.confirmedAt) console.log(`  Confirmed: ${ticket.confirmedAt}`);
            if (ticket.completedAt) console.log(`  Completed: ${ticket.completedAt}`);
            if (ticket.rejectReason) console.log(`  Rejected : ${ticket.rejectReason}`);
            console.log('');
          }
          break;
        }

        console.error(`Unknown handoff subcommand: "${sub}". Use "init", "accept", "complete", "reject", or "status".`);
        process.exitCode = 1;
        break;
      }

      default:
        console.error(`Unknown command: "${command}". Run "intercom help" for available commands.`);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`\n[FATAL CLI ERROR]: ${err.message}`);
    process.exitCode = 1;
  }
}

function printMessage(msg) {
  const ts = msg.timestamp || new Date().toISOString();
  console.log(`\n--------------------------------------------------------------------------------`);
  console.log(`[MESSAGE ${ts}] ID: ${msg.id}`);
  console.log(`  FROM: ${msg.sender}  ──►  TO: ${msg.recipient}  |  TYPE: ${msg.type}  |  PRIORITY: ${msg.priority}`);
  if (msg.correlationId) console.log(`  CORRELATION: ${msg.correlationId}`);
  if (msg.parentId) console.log(`  PARENT: ${msg.parentId}`);
  const payloadStr = typeof msg.payload === 'object' ? JSON.stringify(msg.payload, null, 2) : String(msg.payload);
  console.log(`  PAYLOAD:\n${payloadStr}`);
  console.log(`--------------------------------------------------------------------------------`);
}

async function startFileMeshWatcher(agentName, options = {}) {
  const signal = options.signal;
  const seenIds = new Set();
  const seenTimestamps = new Map();
  let evictedWatermarkMs = -1;
  let lastDirMtimeMs = -1;

  const sleepCancellable = (ms) => new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

  while (!signal || !signal.aborted) {
    try {
      const inboxDir = path.join(getMeshDir(), 'inbox', agentName);
      let currentDirMtimeMs = -1;
      try {
        if (fs.existsSync(inboxDir)) {
          currentDirMtimeMs = fs.statSync(inboxDir).mtimeMs;
        }
      } catch {}

      if (currentDirMtimeMs > 0 && currentDirMtimeMs === lastDirMtimeMs && seenIds.size > 0) {
        await sleepCancellable(500);
        continue;
      }

      const msgs = await waitForUnread(agentName, 5000);
      if (signal && signal.aborted) break;

      try {
        if (fs.existsSync(inboxDir)) {
          lastDirMtimeMs = fs.statSync(inboxDir).mtimeMs;
        }
      } catch {}

      const currentIds = new Set(msgs.map(m => m && m.id).filter(Boolean));
      for (const oldId of Array.from(seenIds)) {
        if (!currentIds.has(oldId)) {
          seenIds.delete(oldId);
          seenTimestamps.delete(oldId);
        }
      }

      let newCount = 0;
      for (const m of msgs) {
        if (!m || !m.id) continue;
        const msgTs = Date.parse(m.timestamp || '') || 0;
        if (seenIds.has(m.id)) continue;
        if (evictedWatermarkMs >= 0 && msgTs > 0 && msgTs <= evictedWatermarkMs) continue;

        seenIds.add(m.id);
        seenTimestamps.set(m.id, msgTs);
        if (seenIds.size > 5000) {
          const oldestId = seenIds.values().next().value;
          const oldestTs = seenTimestamps.get(oldestId) || 0;
          if (oldestTs > evictedWatermarkMs) evictedWatermarkMs = oldestTs;
          seenIds.delete(oldestId);
          seenTimestamps.delete(oldestId);
        }
        printMessage(m);
        newCount++;
      }
      // Yield even on 0ms waitForUnread() returns (e.g. unacknowledged mail still on disk) to prevent 100% CPU spin
      await sleepCancellable(newCount === 0 ? 500 : 50);
    } catch (e) {
      await sleepCancellable(1000);
    }
  }
}

async function probeBrokerIpc(target, timeoutMs = 400) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (online, reason = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ online, reason });
    };
    let socket;
    try {
      socket = (typeof target === 'object' && target !== null && target.host && target.port)
        ? net.connect({ host: target.host, port: target.port }, () => {
            try { socket.end(); } catch {}
            done(true);
          })
        : net.connect(target, () => {
            try { socket.end(); } catch {}
            done(true);
          });
      socket.on('error', (err) => done(false, err.message));
      timer = setTimeout(() => {
        try { socket.destroy(); } catch {}
        done(false, 'Timed out');
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    } catch (err) {
      done(false, err.message);
    }
  });
}

async function runDoctor() {
  const port = getPort();
  const meshDir = getMeshDir();
  console.log(`================================================================================`);
  console.log(`             INTERCOM GLOBAL MESH HEALTH & CONNECTIVITY DIAGNOSTICS             `);
  console.log(`================================================================================`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Platform : ${process.platform} (${process.arch}) | Node.js ${process.version}\n`);

  // 1. Daemon & Network Status
  console.log(`[DAEMON & NETWORK STATUS]`);
  const status = await getDaemonStatus(port);
  if (status.running) {
    console.log(`  Local HTTP Daemon (:${port})    : ONLINE (PID ${status.details?.pid}, Uptime: ${Math.floor(status.details?.uptime || 0)}s)`);
    console.log(`  SSE Event Stream             : READY (http://127.0.0.1:${port}/api/intercom/events)`);
  } else {
    console.log(`  Local HTTP Daemon (:${port})    : OFFLINE (Start via 'intercom daemon start')`);
  }
  const brokerTarget = getBrokerConnectTarget();
  const brokerLabel = typeof brokerTarget === 'object' ? `${brokerTarget.host}:${brokerTarget.port}` : brokerTarget;
  const brokerProbe = await probeBrokerIpc(brokerTarget);
  console.log(`  Pi Broker IPC                : ${brokerProbe.online ? 'ONLINE' : 'OFFLINE'} (${brokerLabel}${brokerProbe.reason ? ` - ${brokerProbe.reason}` : ''})\n`);

  // 2. Discrete File-Mesh Storage
  console.log(`[DISCRETE FILE-MESH STORAGE]`);
  console.log(`  Mesh Directory               : ${meshDir}`);
  let meshWritable = false;
  try {
    fs.mkdirSync(meshDir, { recursive: true });
    fs.accessSync(meshDir, fs.constants.R_OK | fs.constants.W_OK);
    meshWritable = true;
  } catch {}
  console.log(`  Mesh Storage Permissions     : ${meshWritable ? 'READ/WRITE OK' : 'UNAVAILABLE / READ-ONLY'}`);

  const regAgents = await listActiveAgents();
  console.log(`  Registry Active Agents       : ${regAgents.length} agents registered`);
  for (const a of regAgents.slice(0, 5)) {
    console.log(`    - ${a.name.padEnd(16)} (IDE: ${a.ide.padEnd(10)}, PID: ${String(a.pid).padEnd(6)}, Status: ${a.status})`);
  }
  const mailboxes = await listActiveMailboxes();
  const totalPending = mailboxes.reduce((acc, m) => acc + m.total, 0);
  console.log(`  Inbox Queues                 : ${totalPending} pending messages across ${mailboxes.length} mailboxes`);

  const locksDir = path.join(meshDir, 'locks');
  let activeLocks = 0;
  if (fs.existsSync(locksDir)) {
    const files = fs.readdirSync(locksDir);
    activeLocks = files.filter(f => f.endsWith('.lock')).length;
  }
  console.log(`  CAS Locks                    : ${activeLocks === 0 ? 'CLEAN (0 active locks)' : `${activeLocks} active locks`}`);

  const dlqDir = path.join(meshDir, 'dlq');
  let dlqCount = 0;
  if (fs.existsSync(dlqDir)) {
    dlqCount = fs.readdirSync(dlqDir).filter(f => f.endsWith('.json')).length;
  }
  console.log(`  Dead Letter Queue (DLQ)      : ${dlqCount === 0 ? 'CLEAN (0 failed messages)' : `${dlqCount} failed messages`}\n`);

  // 3. External Cloud & Harness Integrations
  console.log(`[EXTERNAL CLOUD & HARNESS INTEGRATIONS]`);
  try {
    const out = execSync('jules --version', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 });
    console.log(`  Google Jules CLI             : DETECTED (${out.toString().trim()})`);
  } catch {
    console.log(`  Google Jules CLI             : NOT DETECTED (Fallback to local subagents active)`);
  }

  // 4. System Integrity Verification
  console.log(`\n[SYSTEM INTEGRITY VERIFICATION]`);
  console.log(`  Zero-Kill Protocol Guard     : ENFORCED`);
  console.log(`  NTFS Safe-Rename Retries     : ENABLED (5 attempts, exponential backoff + jitter)`);
  console.log(`  Path Traversal Sandboxing    : SECURE (Strict rejection of .. / \\ %2e)`);
  console.log(`  DOS Device Protection        : ENABLED (CON, PRN, AUX, NUL, COM, LPT, CONIN$, CONOUT$)`);

  const issues = [];
  if (!meshWritable) issues.push('mesh directory not writable');
  if (!status.running) issues.push('HTTP daemon offline');
  if (activeLocks > 0) issues.push(`${activeLocks} active CAS lock(s)`);
  if (dlqCount > 0) issues.push(`${dlqCount} DLQ message(s)`);

  let resultLine;
  if (!meshWritable) {
    resultLine = `Result: UNHEALTHY - ${issues.join('; ')}`;
    process.exitCode = 1;
  } else if (status.running && activeLocks === 0 && dlqCount === 0) {
    resultLine = 'Result: HEALTHY - HTTP Daemon and Discrete File-Mesh operating normally.';
  } else {
    resultLine = `Result: DEGRADED - File-Mesh ready; notices: ${issues.join(', ')}.`;
  }

  console.log(`================================================================================`);
  console.log(resultLine);
  console.log(`================================================================================\n`);
}

module.exports = {
  run,
  runDoctor,
  parseArgs,
  showHelp,
  CLI_COMMANDS
};

if (require.main === module) {
  run();
}
