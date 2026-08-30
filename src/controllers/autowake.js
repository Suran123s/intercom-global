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
  const done = (result) => {
    if (finished) return;
    finished = true;
    if (callback) callback(result);
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
      console.log(`⚡ [AUTOWAKE PI] Sent direct interrupting turn trigger to Pi session: "${targetName.toUpperCase()}"`);
      setTimeout(() => {
        socket.end();
        done({ delivered: true, method: 'pi-intercom-ipc', target: targetName });
      }, 400);
    }, 150);
  });

  // Safety timeout in case pipe hangs
  const socketTimeout = setTimeout(() => {
    try { socket.destroy(); } catch {}
    done({ delivered: false, method: 'pi-intercom-ipc', reason: 'Connection timed out' });
  }, 2500);

  socket.on('error', (err) => {
    clearTimeout(socketTimeout);
    if (!isRetry) {
      const spawned = tryAutoSpawnPiBroker();
      if (spawned) {
        console.log(`🚀 [AUTOWAKE PI] Auto-spawning background Pi Intercom Broker for "${targetName.toUpperCase()}"...`);
        setTimeout(() => wakePiAgent(targetName, message, callback, true), 1000);
        return;
      }
    }
    done({ delivered: false, method: 'pi-intercom-ipc', reason: `Pi Broker offline: ${err.message}` });
  });

  socket.on('close', () => {
    clearTimeout(socketTimeout);
    done({ delivered: false, method: 'pi-intercom-ipc', reason: 'Socket closed prematurely' });
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
  console.log(`⚡ [AUTOWAKE MAILBOX] Dispatched to durable session mailbox: "${targetName.toUpperCase()}"`);

  if (process.platform === 'win32') {
    exec('powershell -c "[console]::beep(1000, 200)"', { windowsHide: true }, () => {});
  }

  return { delivered: true, method: 'durable-mailbox', file: inboxFile, target: targetName };
}

function wakeOpenCodeAgent(targetName, message, callback) {
  const isOpenCode = targetName.toLowerCase().startsWith('opencode') || targetName.toLowerCase() === 'all';
  const port = process.env.OPENCODE_PORT || 4096;
  const baseUrl = process.env.OPENCODE_URL || `http://127.0.0.1:${port}`;

  if (isOpenCode) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    fetch(`${baseUrl}/session`, {
      method: 'GET',
      signal: controller.signal
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(sessions => {
        clearTimeout(timeout);
        const activeSession = Array.isArray(sessions) && sessions.length > 0 ? sessions[0].id || sessions[0] : 'default';
        return fetch(`${baseUrl}/session/${activeSession}/prompt_async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: `[Intercom AutoWake]: ${message}` })
        }).then(() => activeSession);
      })
      .then((sess) => {
        console.log(`⚡ [AUTOWAKE OPENCODE] Triggered prompt in active OpenCode session (${sess}).`);
        if (callback) callback({ delivered: true, method: 'opencode-rest', url: baseUrl, session: sess });
      })
      .catch((err) => {
        clearTimeout(timeout);
        const reason = `OpenCode API server offline at ${baseUrl} (Start with 'opencode serve')`;
        console.log(`ℹ️ [AUTOWAKE OPENCODE NOTICE] ${reason}`);
        if (callback) callback({ delivered: false, method: 'opencode-rest', reason });
      });
  } else {
    if (callback) callback({ delivered: false, skipped: true });
  }
}

function wakeHermesAgent(targetName, message, callback) {
  const isHermes = targetName.toLowerCase().startsWith('hermes') || targetName.toLowerCase() === 'all';
  const port = process.env.HERMES_PORT || 8000;
  const baseUrl = process.env.HERMES_URL || `http://127.0.0.1:${port}`;

  if (isHermes) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes',
        messages: [{ role: 'user', content: `[Intercom AutoWake]: ${message}` }],
        stream: false
      }),
      signal: controller.signal
    })
      .then(res => {
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`⚡ [AUTOWAKE HERMES] Dispatched prompt to Hermes Gateway API (${baseUrl}).`);
        if (callback) callback({ delivered: true, method: 'hermes-gateway', url: baseUrl });
      })
      .catch((err) => {
        clearTimeout(timeout);
        const reason = `Hermes Gateway offline at ${baseUrl} (Start with 'hermes gateway')`;
        console.log(`ℹ️ [AUTOWAKE HERMES NOTICE] ${reason}`);
        if (callback) callback({ delivered: false, method: 'hermes-gateway', reason });
      });
  } else {
    if (callback) callback({ delivered: false, skipped: true });
  }
}

function wakeCloudAgent(targetName, message) {
  if (targetName.toLowerCase().startsWith('devin')) {
    if (process.env.DEVIN_API_KEY) {
      console.log(`🚀 [AUTOWAKE CLOUD] Triggering Devin API session...`);
      fetch('https://api.devin.ai/v1/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DEVIN_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt: message })
      }).catch(err => console.error('Devin wake error:', err.message));
      return { delivered: true, method: 'devin-cloud' };
    } else {
      const reason = 'Devin API key not set ($env:DEVIN_API_KEY missing)';
      console.log(`ℹ️ [AUTOWAKE CLOUD NOTICE] ${reason}`);
      return { delivered: false, method: 'devin-cloud', reason };
    }
  }
  return { delivered: false, skipped: true };
}

const { showDesktopNotification } = require('../core/notifications');
const { spawnAgent } = require('./spawner');

function wakeAgent(to, message, callback, options = {}) {
  console.log(`\n===========================================================`);
  console.log(`🔔 [UNIVERSAL AUTOWAKE TRIGGER INITIATED]`);
  console.log(`🎯 Recipient : ${to.toUpperCase()}`);
  console.log(`💬 Message   : "${message}"`);
  if (options.autoSpawn) console.log(`🚀 Auto-Spawn: ENABLED (Will attempt launch if offline)`);
  console.log(`===========================================================\n`);

  const runWake = () => {
    const report = {
      target: to,
      timestamp: new Date().toISOString(),
      channels: {}
    };

    wakePiAgent(to, message, (piRes) => {
      report.channels.pi = piRes;
      wakeOpenCodeAgent(to, message, (opencodeRes) => {
        report.channels.opencode = opencodeRes;
        wakeHermesAgent(to, message, (hermesRes) => {
          report.channels.hermes = hermesRes;
          report.channels.mailbox = wakeCliAgent(to, message);
          report.channels.cloud = wakeCloudAgent(to, message);

          // Show OS desktop toast notification if offline or on wake
          showDesktopNotification(`Intercom Task for ${to.toUpperCase()}`, message.slice(0, 100));

          // Summary details
          console.log(`\n📋 [DELIVERY DIAGNOSTICS FOR ${to.toUpperCase()}]:`);
          console.log(`- 📬 Durable Mailbox : ✅ DELIVERED (${report.channels.mailbox.file})`);
          if (report.channels.pi?.delivered) console.log(`- 🥧 Pi IPC Pipe     : ✅ DELIVERED`);
          else if (report.channels.pi?.reason) console.log(`- 🥧 Pi IPC Pipe     : ℹ️ NOT CONNECTED (${report.channels.pi.reason})`);

          if (report.channels.opencode?.delivered) console.log(`- 💻 OpenCode REST   : ✅ PROMPT INJECTED (Session: ${report.channels.opencode.session})`);
          else if (report.channels.opencode?.reason) console.log(`- 💻 OpenCode REST   : ℹ️ OFFLINE (${report.channels.opencode.reason})`);

          if (report.channels.hermes?.delivered) console.log(`- 🦙 Hermes Gateway  : ✅ DISPATCHED (${report.channels.hermes.url})`);
          else if (report.channels.hermes?.reason) console.log(`- 🦙 Hermes Gateway  : ℹ️ OFFLINE (${report.channels.hermes.reason})`);

          if (report.channels.cloud?.delivered) console.log(`- ☁️ Devin Cloud     : ✅ SESSION TRIGGERED`);
          else if (report.channels.cloud?.reason) console.log(`- ☁️ Devin Cloud     : ℹ️ SKIPPED (${report.channels.cloud.reason})`);

          console.log(`- 🔔 Desktop Toast   : ✅ OS NOTIFICATION SENT`);
          console.log(`===========================================================\n`);

          if (callback) callback(report);
        });
      });
    });
  };

  if (options.autoSpawn) {
    spawnAgent(to).then(() => runWake()).catch(() => runWake());
  } else {
    runWake();
  }
}

async function diagnoseMesh() {
  const status = {
    timestamp: new Date().toISOString(),
    services: {}
  };

  // 1. Pi Broker
  status.services.piBroker = await new Promise((resolve) => {
    const socket = connectSocket(PI_PIPE_NAME, () => {
      socket.end();
      resolve({ status: 'ONLINE', target: typeof PI_PIPE_NAME === 'object' ? `${PI_PIPE_NAME.host}:${PI_PIPE_NAME.port}` : PI_PIPE_NAME });
    });
    socket.on('error', (err) => {
      resolve({ status: 'OFFLINE', reason: err.message, remediation: "Launch Pi session with 'pi-intercom' extension" });
    });
    setTimeout(() => {
      try { socket.destroy(); } catch {}
      resolve({ status: 'TIMEOUT', reason: 'Broker socket timed out' });
    }, 1000);
  });

  // 2. OpenCode API
  const opencodePort = process.env.OPENCODE_PORT || 4096;
  const opencodeUrl = process.env.OPENCODE_URL || `http://127.0.0.1:${opencodePort}`;
  status.services.opencodeApi = await fetch(`${opencodeUrl}/session`, { signal: AbortSignal.timeout(1000) })
    .then(res => res.json())
    .then(sessions => ({ status: 'ONLINE', url: opencodeUrl, activeSessions: sessions.length }))
    .catch(err => ({ status: 'OFFLINE', url: opencodeUrl, reason: err.message, remediation: `Start OpenCode with 'opencode serve --port ${opencodePort}'` }));

  // 3. Hermes Gateway
  const hermesPort = process.env.HERMES_PORT || 8000;
  const hermesUrl = process.env.HERMES_URL || `http://127.0.0.1:${hermesPort}`;
  status.services.hermesGateway = await fetch(`${hermesUrl}/v1/models`, { signal: AbortSignal.timeout(1000) })
    .then(res => ({ status: 'ONLINE', url: hermesUrl }))
    .catch(err => ({ status: 'OFFLINE', url: hermesUrl, reason: err.message, remediation: `Start Hermes with 'hermes gateway'` }));

  // 4. Global Intercom Daemon
  const { PORT } = require('../config');
  status.services.intercomDaemon = await fetch(`http://localhost:${PORT}/.well-known/agent.json`, { signal: AbortSignal.timeout(1000) })
    .then(res => res.json())
    .then(card => ({ status: 'ONLINE', url: `http://localhost:${PORT}`, agentCard: card.name }))
    .catch(err => ({ status: 'OFFLINE', url: `http://localhost:${PORT}`, reason: err.message, remediation: "Start daemon with 'intercom server'" }));

  // 5. Active Mailboxes
  const { listActiveMailboxes } = require('../core/mesh');
  status.mailboxes = listActiveMailboxes();

  return status;
}

module.exports = {
  wakeAgent,
  wakePiAgent,
  wakeOpenCodeAgent,
  wakeHermesAgent,
  wakeCliAgent,
  wakeCloudAgent,
  diagnoseMesh
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
