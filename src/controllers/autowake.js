// src/controllers/autowake.js - Universal Multi-Agent Auto-Wake & Interrupt Controller
const net = require('net');
const { getBrokerConnectTarget, getPort } = require('../config');
const { validateAgentName, sanitizeAgentName, writeMessageSync, listActiveMailboxes } = require('../core/mesh');
const { MessageEnvelope } = require('../core/message');
const piIntercom = require('../bridges/pi-intercom');
const { spawnAgent } = require('./spawner');

const connectSocket = piIntercom.connectSocket || ((target, connectListener) => {
  if (typeof target === 'object' && target !== null && target.host && target.port) {
    return net.connect({ host: target.host, port: target.port }, connectListener);
  }
  return net.connect(target, connectListener);
});

function wakePiAgent(targetName, message, callback, isRetry = false) {
  let finished = false;
  let retryPending = false;
  let socketTimeout = null;
  let registerTimer = null;
  let endTimer = null;
  let retryTimer = null;

  const clearTimers = () => {
    if (socketTimeout) { clearTimeout(socketTimeout); socketTimeout = null; }
    if (registerTimer) { clearTimeout(registerTimer); registerTimer = null; }
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };

  const done = (result) => {
    if (finished) return;
    finished = true;
    clearTimers();
    if (callback) callback(result);
  };

  const socket = connectSocket(getBrokerConnectTarget(), () => {
    const senderId = 'wake-' + Date.now();
    piIntercom.writeFrame(socket, {
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

    registerTimer = setTimeout(() => {
      if (finished) return;
      const msgId = 'msg-' + Date.now();
      piIntercom.writeFrame(socket, {
        type: 'send',
        to: targetName,
        message: {
          id: msgId,
          timestamp: Date.now(),
          content: { text: message }
        }
      });
      console.log(`⚡ [AUTOWAKE PI] Sent direct interrupting turn trigger to Pi session: "${String(targetName).toUpperCase()}"`);
      endTimer = setTimeout(() => {
        try { socket.end(); } catch {}
        done({ delivered: true, method: 'pi-intercom-ipc', target: targetName });
      }, 400);
    }, 150);
  });

  // Safety timeout in case pipe hangs
  socketTimeout = setTimeout(() => {
    try { socket.destroy(); } catch {}
    done({ delivered: false, method: 'pi-intercom-ipc', reason: 'Connection timed out' });
  }, 2500);

  socket.on('error', (err) => {
    if (socketTimeout) { clearTimeout(socketTimeout); socketTimeout = null; }
    if (!isRetry) {
      const spawned = piIntercom.tryAutoSpawnPiBroker();
      if (spawned) {
        retryPending = true;
        console.log(`🚀 [AUTOWAKE PI] Auto-spawning background Pi Intercom Broker for "${String(targetName).toUpperCase()}"...`);
        retryTimer = setTimeout(() => {
          retryPending = false;
          wakePiAgent(targetName, message, callback, true);
        }, 1000);
        return;
      }
    }
    done({ delivered: false, method: 'pi-intercom-ipc', reason: `Pi Broker offline: ${err.message}` });
  });

  socket.on('close', () => {
    if (retryPending) return;
    done({ delivered: false, method: 'pi-intercom-ipc', reason: 'Socket closed prematurely' });
  });
}

function wakeCliAgent(targetName, message) {
  let cleanTarget;
  try {
    cleanTarget = validateAgentName(targetName);
  } catch {
    cleanTarget = sanitizeAgentName(targetName);
  }

  const envelope = MessageEnvelope.create({
    sender: 'autowake',
    recipient: cleanTarget,
    type: 'task_dispatch',
    payload: { message }
  });

  const writeRes = writeMessageSync(cleanTarget, envelope);
  console.log(`⚡ [AUTOWAKE MAILBOX] Dispatched to durable session mailbox: "${cleanTarget.toUpperCase()}"`);

  // Audio beep completely removed

  return { delivered: true, method: 'durable-mailbox', file: writeRes.path, target: cleanTarget };
}

function wakeOpenCodeAgent(targetName, message, callback) {
  const isOpenCode = targetName.toLowerCase().startsWith('opencode') || targetName.toLowerCase() === 'all';
  const port = process.env.OPENCODE_PORT || 4096;
  const baseUrl = process.env.OPENCODE_URL || `http://127.0.0.1:${port}`;

  if (isOpenCode) {
    fetch(`${baseUrl}/session`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500)
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(async (sessions) => {
        const activeSession = Array.isArray(sessions) && sessions.length > 0 ? sessions[0].id || sessions[0] : 'default';
        const promptRes = await fetch(`${baseUrl}/session/${encodeURIComponent(String(activeSession))}/prompt_async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: `[Intercom AutoWake]: ${message}` }),
          signal: AbortSignal.timeout(1500)
        });
        if (!promptRes.ok) {
          throw new Error(`HTTP ${promptRes.status}`);
        }
        return activeSession;
      })
      .then((sess) => {
        console.log(`⚡ [AUTOWAKE OPENCODE] Triggered prompt in active OpenCode session (${sess}).`);
        if (callback) callback({ delivered: true, method: 'opencode-rest', url: baseUrl, session: sess });
      })
      .catch(() => {
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
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes',
        messages: [{ role: 'user', content: `[Intercom AutoWake]: ${message}` }],
        stream: false
      }),
      signal: AbortSignal.timeout(1500)
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`⚡ [AUTOWAKE HERMES] Dispatched prompt to Hermes Gateway API (${baseUrl}).`);
        if (callback) callback({ delivered: true, method: 'hermes-gateway', url: baseUrl });
      })
      .catch(() => {
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
        body: JSON.stringify({ prompt: message }),
        signal: AbortSignal.timeout(3000)
      })
        .then((res) => {
          if (!res.ok) {
            console.error(`Devin wake error: HTTP ${res.status}`);
          }
        })
        .catch(err => console.error('Devin wake error:', err.message));
      return { delivered: true, method: 'devin-cloud' };
    } else {
      const reason = 'Devin API key not set ($env:DEVIN_API_KEY missing)';
      console.log(`ℹ️ [AUTOWAKE CLOUD NOTICE] ${reason}`);
      return { delivered: false, method: 'devin-cloud', reason };
    }
  }
  return { delivered: false, skipped: true };
}

function logWakeHeader(to, message, options = {}) {
  console.log(`\n===========================================================`);
  console.log(`🔔 [UNIVERSAL AUTOWAKE TRIGGER INITIATED]`);
  console.log(`🎯 Recipient : ${to.toUpperCase()}`);
  console.log(`💬 Message   : "${message}"`);
  if (options.autoSpawn) console.log(`🚀 Auto-Spawn: ENABLED (Will attempt launch if offline)`);
  console.log(`===========================================================\n`);
}

function logDeliveryDiagnostics(to, channels) {
  console.log(`\n📋 [DELIVERY DIAGNOSTICS FOR ${to.toUpperCase()}]:`);
  console.log(`- 📬 Durable Mailbox : ✅ DELIVERED (${channels.mailbox?.file})`);
  if (channels.pi?.delivered) console.log(`- 🥧 Pi IPC Pipe     : ✅ DELIVERED`);
  else if (channels.pi?.reason) console.log(`- 🥧 Pi IPC Pipe     : ℹ️ NOT CONNECTED (${channels.pi.reason})`);

  if (channels.opencode?.delivered) console.log(`- 💻 OpenCode REST   : ✅ PROMPT INJECTED (Session: ${channels.opencode.session})`);
  else if (channels.opencode?.reason) console.log(`- 💻 OpenCode REST   : ℹ️ OFFLINE (${channels.opencode.reason})`);

  if (channels.hermes?.delivered) console.log(`- 🦙 Hermes Gateway  : ✅ DISPATCHED (${channels.hermes.url})`);
  else if (channels.hermes?.reason) console.log(`- 🦙 Hermes Gateway  : ℹ️ OFFLINE (${channels.hermes.reason})`);

  if (channels.cloud?.delivered) console.log(`- ☁️ Devin Cloud     : ✅ SESSION TRIGGERED`);
  else if (channels.cloud?.reason) console.log(`- ☁️ Devin Cloud     : ℹ️ SKIPPED (${channels.cloud.reason})`);

  console.log(`- 🔔 Desktop Toast   : ℹ️ OS NOTIFICATION DISABLED`);
  console.log(`===========================================================\n`);
}

async function dispatchChannels(to, message) {
  const pi = await new Promise((resolve) => wakePiAgent(to, message, resolve));
  const opencode = await new Promise((resolve) => wakeOpenCodeAgent(to, message, resolve));
  const hermes = await new Promise((resolve) => wakeHermesAgent(to, message, resolve));
  const mailbox = wakeCliAgent(to, message);
  const cloud = wakeCloudAgent(to, message);

  return { pi, opencode, hermes, mailbox, cloud };
}

async function executeWake(to, message, callback) {
  const channels = await dispatchChannels(to, message);
  const report = {
    target: to,
    timestamp: new Date().toISOString(),
    channels
  };

  // OS balloon notification disabled
  logDeliveryDiagnostics(to, channels);

  if (callback) callback(report);
  return report;
}

function wakeAgent(to, message, callback, options = {}) {
  logWakeHeader(to, message, options);

  const runWake = () => executeWake(to, message, callback);

  if (options.autoSpawn) {
    spawnAgent(to).then(runWake).catch(runWake);
  } else {
    runWake();
  }
}

async function diagnoseMesh() {
  const status = {
    timestamp: new Date().toISOString(),
    services: {}
  };

  const piTarget = getBrokerConnectTarget();
  const port = getPort();

  // 1. Pi Broker
  status.services.piBroker = await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(res);
    };

    const socket = connectSocket(piTarget, () => {
      try { socket.end(); } catch {}
      finish({ status: 'ONLINE', target: typeof piTarget === 'object' ? `${piTarget.host}:${piTarget.port}` : piTarget });
    });
    socket.on('error', (err) => {
      finish({ status: 'OFFLINE', reason: err.message, remediation: "Launch Pi session with 'pi-intercom' extension" });
    });
    timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      finish({ status: 'TIMEOUT', reason: 'Broker socket timed out' });
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
  });

  // 2. OpenCode API
  const opencodePort = process.env.OPENCODE_PORT || 4096;
  const opencodeUrl = process.env.OPENCODE_URL || `http://127.0.0.1:${opencodePort}`;
  status.services.opencodeApi = await fetch(`${opencodeUrl}/session`, { signal: AbortSignal.timeout(1000) })
    .then(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sessions = await res.json();
      return { status: 'ONLINE', url: opencodeUrl, activeSessions: Array.isArray(sessions) ? sessions.length : 0 };
    })
    .catch(err => ({ status: 'OFFLINE', url: opencodeUrl, reason: err.message, remediation: `Start OpenCode with 'opencode serve --port ${opencodePort}'` }));

  // 3. Hermes Gateway
  const hermesPort = process.env.HERMES_PORT || 8000;
  const hermesUrl = process.env.HERMES_URL || `http://127.0.0.1:${hermesPort}`;
  status.services.hermesGateway = await fetch(`${hermesUrl}/v1/models`, { signal: AbortSignal.timeout(1000) })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: 'ONLINE', url: hermesUrl };
    })
    .catch(err => ({ status: 'OFFLINE', url: hermesUrl, reason: err.message, remediation: `Start Hermes with 'hermes gateway'` }));

  // 4. Global Intercom Daemon
  status.services.intercomDaemon = await fetch(`http://127.0.0.1:${port}/.well-known/agent.json`, { signal: AbortSignal.timeout(1000) })
    .then(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const card = await res.json();
      return { status: 'ONLINE', url: `http://127.0.0.1:${port}`, agentCard: card.name };
    })
    .catch(err => ({ status: 'OFFLINE', url: `http://127.0.0.1:${port}`, reason: err.message, remediation: "Start daemon with 'intercom server'" }));

  // 5. Active Mailboxes
  status.mailboxes = await listActiveMailboxes();

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
