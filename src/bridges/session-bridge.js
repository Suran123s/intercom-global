// src/bridges/session-bridge.js - Live Stdin/Stdout Bridge for Interactive CLI Sessions
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { MESH_DIR } = require('../config');

function startSessionBridge(agentName = 'cli-agent', sessionId = 's-' + Math.random().toString(36).substring(2, 8), command = 'powershell', cmdArgs = []) {
  const fullAgentTag = `${agentName.toLowerCase()}#${sessionId}`;
  const inboxFile = path.join(MESH_DIR, `${agentName.toLowerCase()}.json`);
  const sessionInboxFile = path.join(MESH_DIR, `${agentName.toLowerCase()}-${sessionId}.json`);

  console.log(`\n=============================================================`);
  console.log(`🚀 [GLOBAL INTERCOM SESSION BRIDGE ACTIVE]`);
  console.log(`👤 Agent Tag     : ${fullAgentTag.toUpperCase()}`);
  console.log(`🆔 Session ID    : ${sessionId}`);
  console.log(`📁 Session Inbox : ${path.basename(sessionInboxFile)}`);
  console.log(`▶️  Running CLI   : ${command} ${cmdArgs.join(' ')}`);
  console.log(`=============================================================\n`);

  const child = spawn(command, cmdArgs, {
    stdio: ['pipe', process.stdout, process.stderr],
    shell: true
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    child.stdin.write(line + '\n');
  });

  function checkInbox(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const unread = data.filter(m => !m.read);
      if (unread.length > 0) {
        data.forEach(m => (m.read = true));
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      }
      return unread;
    } catch {
      return [];
    }
  }

  const pollInterval = setInterval(() => {
    // 1. Session specific
    const sessionMessages = checkInbox(sessionInboxFile);
    sessionMessages.forEach(msg => {
      console.log(`\n⚡ [INJECTING TASK FROM ${msg.from.toUpperCase()}] ──► ${fullAgentTag}`);
      child.stdin.write(msg.message + '\n');
    });

    // 2. Targeted general
    if (fs.existsSync(inboxFile)) {
      try {
        const allMsgs = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
        let modified = false;
        allMsgs.forEach(m => {
          if (!m.read && (m.to.toLowerCase() === fullAgentTag || m.to.toLowerCase() === agentName.toLowerCase())) {
            if (m.to.toLowerCase() === fullAgentTag || !m.to.includes('#')) {
              console.log(`\n⚡ [INJECTING TASK FROM ${m.from.toUpperCase()}] ──► ${fullAgentTag}`);
              child.stdin.write(m.message + '\n');
              m.read = true;
              modified = true;
            }
          }
        });
        if (modified) {
          fs.writeFileSync(inboxFile, JSON.stringify(allMsgs, null, 2), 'utf8');
        }
      } catch {}
    }
  }, 1000);

  child.on('close', (code) => {
    clearInterval(pollInterval);
    console.log(`\n[Session Bridge] Process closed with exit code ${code}`);
    process.exit(code || 0);
  });
}

module.exports = { startSessionBridge };

if (require.main === module) {
  const args = process.argv.slice(2);
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
