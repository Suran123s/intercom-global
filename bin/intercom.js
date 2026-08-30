#!/usr/bin/env node
// bin/intercom.js - Main CLI Executable
const { dispatchMessage, createServer } = require('../src/core/server');
const { checkAndMarkRead, listActiveMailboxes, readInbox, clearInbox, waitForUnread } = require('../src/core/mesh');
const { wakeAgent } = require('../src/controllers/autowake');
const { PiIntercomClient } = require('../src/bridges/pi-intercom');
const { startSessionBridge } = require('../src/bridges/session-bridge');
const { generateAgentCard, processA2AMessage } = require('../src/bridges/a2a');
const { PORT } = require('../src/config');

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
📡 Intercom Global - Universal Multi-Agent Communication & Auto-Wake CLI

USAGE:
  intercom send --from <name> --to <name> --msg "<message>"    Send a message
  intercom wake --to <name> --msg "<message>"                   Interrupt & auto-wake an agent
  intercom watch --agent <name> [--timeout <sec>] [--json]     Wait reactively for incoming messages
  intercom check --agent <name>                                Check & mark inbox as read
  intercom read --agent <name>                                 View all messages in inbox
  intercom clear --agent <name>                                Clear/empty an agent's inbox
  intercom peers                                               List all active mailboxes
  intercom a2a card                                            Display A2A v1.0 Agent Card
  intercom a2a send --to <name> --msg "<message>"              Dispatch via A2A protocol
  intercom pi list                                             List active Pi sessions via IPC
  intercom pi send --to <session> --msg "<message>"            Send directly over Pi Named Pipe
  intercom pi ask --to <session> --question "<question>"       Ask a question and wait for reply
  intercom bridge --agent <name> [--session <id>] -- <cli>     Wrap an interactive CLI session
  intercom server [--port 4150] [--auto-reply]                 Start the background HTTP daemon
`);
}

if (!command || command === '--help' || command === '-h' || command === 'help') {
  showHelp();
  process.exit(0);
}

if (command === 'watch') {
  const agentIdx = args.indexOf('--agent');
  if (agentIdx === -1) {
    console.error('Error: Required argument: --agent <name>');
    process.exit(1);
  }
  const agent = args[agentIdx + 1];
  const timeoutIdx = args.indexOf('--timeout');
  const timeoutSec = timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1], 10) : 300;
  const timeoutMs = (isNaN(timeoutSec) ? 300 : timeoutSec) * 1000;
  const isJson = args.includes('--json');

  if (!isJson) {
    console.log(`👀 [INTERCOM WATCH] Waiting for incoming messages for agent "${agent}" (timeout: ${timeoutSec}s)...`);
  }

  waitForUnread(agent, timeoutMs).then((messages) => {
    if (messages.length === 0) {
      if (isJson) {
        console.log(JSON.stringify([]));
      } else {
        console.log(`⏱️ [TIMEOUT] No new messages received for "${agent}".`);
      }
      process.exit(0);
    }

    if (isJson) {
      console.log(JSON.stringify(messages, null, 2));
    } else {
      console.log(`\n📬 [${messages.length} NEW MESSAGE(S) RECEIVED FOR ${agent.toUpperCase()}]:`);
      messages.forEach(m => {
        console.log(`\n⚡ [From ${m.from.toUpperCase()}] (${m.timestamp}):\n${m.message}`);
      });
    }
    process.exit(0);
  });
}

if (command === 'clear' || command === 'clean') {
  const agentIdx = args.indexOf('--agent');
  if (agentIdx === -1) {
    console.error('Error: Required argument: --agent <name>');
    process.exit(1);
  }
  const agent = args[agentIdx + 1];
  clearInbox(agent);
  console.log(`✔ Cleared inbox for agent "${agent}".`);
  process.exit(0);
}

if (command === 'send') {
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  const msgIdx = args.indexOf('--msg');

  if (fromIdx === -1 || toIdx === -1 || msgIdx === -1) {
    console.error('Error: Required arguments: --from <name> --to <name> --msg "<text>"');
    process.exit(1);
  }

  const from = args[fromIdx + 1];
  const to = args[toIdx + 1];
  const msg = args[msgIdx + 1];

  dispatchMessage(from, to, msg);
  console.log(`✔ Message delivered to "${to}"`);
  process.exit(0);
}

if (command === 'wake') {
  const toIdx = args.indexOf('--to');
  const msgIdx = args.indexOf('--msg');

  if (toIdx === -1 || msgIdx === -1) {
    console.error('Error: Required arguments: --to <name> --msg "<text>"');
    process.exit(1);
  }

  const to = args[toIdx + 1];
  const msg = args[msgIdx + 1];

  wakeAgent(to, msg, () => {
    setTimeout(() => process.exit(0), 400);
  });
}

if (command === 'check') {
  const agentIdx = args.indexOf('--agent');
  if (agentIdx === -1) {
    console.error('Error: Required argument: --agent <name>');
    process.exit(1);
  }
  const agent = args[agentIdx + 1];
  const unread = checkAndMarkRead(agent);
  if (unread.length === 0) {
    console.log(`📭 No new unread messages for "${agent}".`);
  } else {
    console.log(`📬 [${unread.length} NEW MESSAGES FOR ${agent.toUpperCase()}]:`);
    unread.forEach(m => {
      console.log(`\n- [From ${m.from.toUpperCase()}] (${m.timestamp}):\n  "${m.message}"`);
    });
  }
  process.exit(0);
}

if (command === 'read') {
  const agentIdx = args.indexOf('--agent');
  if (agentIdx === -1) {
    console.error('Error: Required argument: --agent <name>');
    process.exit(1);
  }
  const agent = args[agentIdx + 1];
  const all = readInbox(agent);
  console.log(JSON.stringify(all, null, 2));
  process.exit(0);
}

if (command === 'peers') {
  const peers = listActiveMailboxes();
  console.log('\n📋 [ACTIVE REGISTERED COMPANIONS & MAILBOXES]:');
  peers.forEach(p => {
    console.log(`- 📦 [${p.name}] Total: ${p.total} | Unread: ${p.unread}`);
  });
  process.exit(0);
}

if (command === 'a2a') {
  const subCmd = args[1];
  if (!subCmd || subCmd === 'card') {
    const card = generateAgentCard();
    console.log(JSON.stringify(card, null, 2));
    process.exit(0);
  } else if (subCmd === 'send') {
    const toIdx = args.indexOf('--to');
    const msgIdx = args.indexOf('--msg');
    if (toIdx === -1 || msgIdx === -1) {
      console.error('Error: Usage: intercom a2a send --to <agent> --msg "<message>"');
      process.exit(1);
    }
    const to = args[toIdx + 1];
    const msg = args[msgIdx + 1];
    const task = processA2AMessage({ to, message: msg, from: 'a2a-cli' }, dispatchMessage);
    console.log(JSON.stringify(task, null, 2));
    process.exit(0);
  } else {
    console.error('Unknown a2a subcommand. Use: card, send');
    process.exit(1);
  }
}

if (command === 'pi') {
  const subCmd = args[1];
  const client = new PiIntercomClient({ name: 'intercom-cli' });

  if (subCmd === 'list') {
    client.connect(() => {
      setTimeout(() => {
        client.listSessions(sessions => {
          console.log('\nConnected Pi Sessions:\n', JSON.stringify(sessions, null, 2));
          process.exit(0);
        });
      }, 300);
    });
  } else if (subCmd === 'send') {
    const toIdx = args.indexOf('--to');
    const msgIdx = args.indexOf('--msg');
    if (toIdx === -1 || msgIdx === -1) {
      console.error('Error: Usage: intercom pi send --to <session> --msg "<text>"');
      process.exit(1);
    }
    client.connect(() => {
      setTimeout(() => {
        client.sendMessage(args[toIdx + 1], args[msgIdx + 1]);
        setTimeout(() => process.exit(0), 600);
      }, 300);
    });
  } else if (subCmd === 'ask') {
    const toIdx = args.indexOf('--to');
    const qIdx = args.indexOf('--question');
    if (toIdx === -1 || qIdx === -1) {
      console.error('Error: Usage: intercom pi ask --to <session> --question "<question>"');
      process.exit(1);
    }
    client.connect(() => {
      setTimeout(() => {
        client.ask(args[toIdx + 1], args[qIdx + 1], (reply) => {
          console.log(`\n💬 [PI REPLY RECEIVED]:\n${reply}\n`);
          process.exit(0);
        });
      }, 300);
    });
  } else {
    console.error('Unknown pi subcommand. Use: list, send, ask');
    process.exit(1);
  }
}

if (command === 'bridge') {
  let agent = 'cli-agent';
  let sessionId = 's-' + Math.random().toString(36).substring(2, 8);
  let cmdIndex = args.indexOf('--');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) agent = args[i + 1].toLowerCase();
    if (args[i] === '--session' && args[i + 1]) sessionId = args[i + 1];
  }

  const commandArgs = cmdIndex !== -1 ? args.slice(cmdIndex + 1) : ['powershell'];
  startSessionBridge(agent, sessionId, commandArgs[0], commandArgs.slice(1));
}

if (command === 'server') {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`\n=============================================================`);
    console.log(`📡 [INTERCOM GLOBAL DAEMON RUNNING]`);
    console.log(`🌐 Port          : http://localhost:${PORT}`);
    console.log(`🤖 Auto-Reply   : ${process.argv.includes('--auto-reply') ? 'ENABLED' : 'DISABLED'}`);
    console.log(`=============================================================\n`);
  });
}
