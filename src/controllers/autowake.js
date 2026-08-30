// src/controllers/autowake.js - Universal Multi-Agent Auto-Wake & Interrupt Controller
const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { PI_PIPE_NAME, MESH_DIR } = require('../config');
const { writeFrame, tryAutoSpawnPiBroker } = require('../bridges/pi-intercom');

function connectSocket(target, connectListener) {
  if (typeof target === 'object' && target !== null && target.host && target.port) {
    return net.connect({ host: target.host, port: target.port }, connectListener);
  }
  return net.connect(target, connectListener);
}

function wakePiAgent(targetName, message, callback, isRetry = false) {
  let finished = false;
  const done = (success) => {
    if (finished) return;
    finished = true;
    if (callback) callback(success);
  };

  const socket = connectSocket(PI_PIPE_NAME, () => {
    const senderId = 'wake-' + Date.now();
    writeFrame(socket, {
      type: 'register',
      protocolVersion: 1,
      session: {
        id: senderId,
        name: 'autowake-controller',
        cwd: process.cwd(),
        model: 'autowake-controller',
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        status: 'active'
      }
    });

    setTimeout(() => {
      const msgId = 'msg-' + Date.now();
      writeFrame(socket, {
        type: 'send',
        to: targetName,
        message: {
          id: msgId,
          timestamp: Date.now(),
          content: { text: message }
        }
      });
      console.log(`⚡ [AUTOWAKE] Sent direct interrupting turn trigger to Pi session: "${targetName.toUpperCase()}"`);
      setTimeout(() => {
        socket.end();
        done(true);
      }, 400);
    }, 150);
  });

  // Safety timeout in case pipe hangs
  const socketTimeout = setTimeout(() => {
    try { socket.destroy(); } catch {}
    done(false);
  }, 3000);

  socket.on('error', (err) => {
    clearTimeout(socketTimeout);
    if (!isRetry) {
      const spawned = tryAutoSpawnPiBroker();
      if (spawned) {
        console.log(`🚀 [AUTOWAKE] Auto-spawning background Pi Intercom Broker for "${targetName.toUpperCase()}"...`);
        setTimeout(() => wakePiAgent(targetName, message, callback, true), 1000);
        return;
      }
    }
    console.log(`[Pi Intercom Pipe Notice]: ${err.message}`);
    done(false);
  });

  socket.on('close', () => {
    clearTimeout(socketTimeout);
    done(false);
  });
}

function wakeCliAgent(targetName, message) {
  const inboxFile = path.join(MESH_DIR, `${targetName.toLowerCase()}.json`);
  let inbox = [];
  try { inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8')); } catch {}
  inbox.push({
    id: Date.now(),
    from: 'autowake',
    to: targetName,
    message: message,
    timestamp: new Date().toISOString(),
    read: false
  });
  fs.writeFileSync(inboxFile, JSON.stringify(inbox, null, 2), 'utf8');
  console.log(`⚡ [AUTOWAKE] Dispatched to CLI session mailbox: "${targetName.toUpperCase()}"`);

  if (process.platform === 'win32') {
    exec('powershell -c "[console]::beep(1000, 200)"', { windowsHide: true }, () => {});
  }
}

function wakeCloudAgent(targetName, message) {
  if (targetName.toLowerCase().startsWith('devin') && process.env.DEVIN_API_KEY) {
    console.log(`🚀 [AUTOWAKE CLOUD] Triggering Devin API session...`);
    fetch('https://api.devin.ai/v1/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEVIN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: message })
    }).catch(err => console.error('Devin wake error:', err.message));
  }
}

function wakeAgent(to, message, callback) {
  console.log(`\n===========================================================`);
  console.log(`🔔 [UNIVERSAL AUTOWAKE TRIGGER INITIATED]`);
  console.log(`🎯 Recipient : ${to.toUpperCase()}`);
  console.log(`💬 Message   : "${message}"`);
  console.log(`===========================================================\n`);

  wakePiAgent(to, message, () => {
    wakeCliAgent(to, message);
    wakeCloudAgent(to, message);
    if (callback) callback();
  });
}

module.exports = {
  wakeAgent,
  wakePiAgent,
  wakeCliAgent,
  wakeCloudAgent
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const toIdx = args.indexOf('--to');
  const msgIdx = args.indexOf('--msg');
  if (toIdx === -1 || msgIdx === -1) {
    console.error('Usage: node autowake.js --to <agentName> --msg "<task>"');
    process.exit(1);
  }
  wakeAgent(args[toIdx + 1], args[msgIdx + 1], () => {
    setTimeout(() => process.exit(0), 500);
  });
}
