#!/usr/bin/env node
// src/core/daemon-manager.js
// Manages the intercom HTTP daemon as a persistent background process with PID file
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../config');

const PID_FILE = path.join(MESH_DIR, 'daemon.pid');
const BIN_FILE = path.join(__dirname, '../../bin/intercom.js');

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function startDaemon(port = 4150) {
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    return { status: 'already_running', pid: existingPid, port };
  }

  const child = spawn(process.execPath, [BIN_FILE, 'server', '--port', String(port)], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  return { status: 'started', pid: child.pid, port };
}

function stopDaemon() {
  const pid = readPid();
  if (!pid) return { status: 'not_running' };
  if (!isRunning(pid)) {
    fs.unlinkSync(PID_FILE);
    return { status: 'not_running' };
  }
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    return { status: 'stopped', pid };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

function daemonStatus() {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    return { status: 'offline', pid: null };
  }
  return { status: 'online', pid };
}

module.exports = { startDaemon, stopDaemon, daemonStatus, readPid };