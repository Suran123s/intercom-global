#!/usr/bin/env node
// src/core/daemon-manager.js
// Manages the intercom HTTP daemon as a persistent background process with port-aware PID tracking
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getMeshDir } = require('../config');

const BIN_FILE = path.join(__dirname, '../../bin/intercom.js');
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP_BUF, 0, 0, ms);
  } catch {}
}

function getDefaultPidFile() {
  return path.join(getMeshDir(), 'daemon.pid');
}

function getPortPidFile(port) {
  return path.join(getMeshDir(), `daemon.${port}.pid`);
}

function unlinkIgnoreEnoent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function isRunning(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function parsePidContent(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const pid = parseInt(trimmed, 10);
    return Number.isInteger(pid) && pid > 0 ? { pid, port: null } : null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return { pid: parsed.pid, port: Number.isInteger(parsed.port) ? parsed.port : null };
    }
  } catch {}
  return null;
}

function readPidRecord(port = null) {
  if (port !== null && port !== undefined) {
    const portFile = getPortPidFile(port);
    if (fs.existsSync(portFile)) {
      try {
        const rec = parsePidContent(fs.readFileSync(portFile, 'utf8'));
        if (rec) return { ...rec, port: rec.port || port, filePath: portFile };
      } catch {}
    }
  }

  const defaultFile = getDefaultPidFile();
  if (!fs.existsSync(defaultFile)) return null;
  try {
    const rec = parsePidContent(fs.readFileSync(defaultFile, 'utf8'));
    if (!rec) return null;
    if (port !== null && port !== undefined && rec.port !== null && rec.port !== port) {
      return null;
    }
    return { ...rec, filePath: defaultFile };
  } catch {
    return null;
  }
}

function readPid(port = null) {
  const rec = readPidRecord(port);
  return rec ? rec.pid : null;
}

function probeHealthSync(port) {
  try {
    const script = `const h=require('http');const r=h.get('http://127.0.0.1:${Number(port)}/api/intercom/health',{timeout:400},res=>{process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1);});`;
    execFileSync(process.execPath, ['-e', script], { timeout: 800, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function sendGracefulShutdownSync(port) {
  if (!port || !Number.isInteger(Number(port))) return false;
  try {
    const script = `const h=require('http');const r=h.request({hostname:'127.0.0.1',port:${Number(port)},path:'/api/intercom/shutdown',method:'POST',timeout:800},res=>{res.resume();process.exit(res.statusCode>=200&&res.statusCode<300?0:1)});r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1);});r.end();`;
    execFileSync(process.execPath, ['-e', script], { timeout: 1200, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function startDaemon(port = 4150) {
  const existing = readPidRecord(port);
  if (existing && isRunning(existing.pid)) {
    return { status: 'already_running', pid: existing.pid, port: existing.port || port };
  }

  fs.mkdirSync(getMeshDir(), { recursive: true });

  const child = spawn(process.execPath, [BIN_FILE, '__daemon_run', `--port=${port}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  // Child writes its port-aware PID file after server.listen() succeeds; poll until bound & healthy
  const deadline = Date.now() + 3000;
  let bound = false;
  while (Date.now() < deadline) {
    const rec = readPidRecord(port);
    if (rec && rec.pid === child.pid) {
      bound = true;
      break;
    }
    if (!isRunning(child.pid)) {
      break;
    }
    sleepSync(50);
  }

  if (!bound && isRunning(child.pid)) {
    // Check health endpoint once in case PID file write was delayed
    if (probeHealthSync(port)) {
      bound = true;
    }
  }

  if (!bound && !isRunning(child.pid)) {
    return { status: 'error', error: `Daemon process exited before binding port ${port}`, port };
  }

  return { status: 'started', pid: child.pid, port };
}

function stopDaemon(port = null) {
  const rec = readPidRecord(port);
  if (!rec) return { status: 'not_running' };

  const targetPort = port !== null && port !== undefined ? port : rec.port;
  const defaultFile = getDefaultPidFile();
  const portFile = targetPort ? getPortPidFile(targetPort) : null;

  const cleanupPidFiles = () => {
    try { unlinkIgnoreEnoent(rec.filePath); } catch {}
    if (portFile) {
      try { unlinkIgnoreEnoent(portFile); } catch {}
    }
    try {
      const defRec = fs.existsSync(defaultFile) ? parsePidContent(fs.readFileSync(defaultFile, 'utf8')) : null;
      if (defRec && defRec.pid === rec.pid) {
        unlinkIgnoreEnoent(defaultFile);
      }
    } catch {}
  };

  if (!isRunning(rec.pid)) {
    cleanupPidFiles();
    return { status: 'not_running' };
  }

  try {
    // Attempt graceful HTTP shutdown before SIGTERM so SSE streams flush/close cleanly on Windows
    if (targetPort) {
      const sent = sendGracefulShutdownSync(targetPort);
      if (sent) {
        const deadline = Date.now() + 800;
        while (Date.now() < deadline && isRunning(rec.pid)) {
          sleepSync(50);
        }
      }
    }

    if (rec.pid !== process.pid && isRunning(rec.pid)) {
      try {
        process.kill(rec.pid, 'SIGTERM');
      } catch (killErr) {
        if (killErr.code !== 'ESRCH') throw killErr;
      }
      const killDeadline = Date.now() + 500;
      while (Date.now() < killDeadline && isRunning(rec.pid)) {
        sleepSync(25);
      }
    }

    cleanupPidFiles();
    return { status: 'stopped', pid: rec.pid };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

function daemonStatus(port = null) {
  const rec = readPidRecord(port);
  if (!rec || !isRunning(rec.pid)) {
    return { status: 'offline', pid: null };
  }
  return { status: 'online', pid: rec.pid };
}

module.exports = { startDaemon, stopDaemon, daemonStatus, readPid };
