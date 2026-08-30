// src/controllers/spawner.js - On-Demand Dynamic Agent Process Auto-Spawner
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tryAutoSpawnPiBroker } = require('../bridges/pi-intercom');
const { MESH_DIR } = require('../config');

const CONFIG_FILE = path.join(path.dirname(MESH_DIR), 'agents.config.json');

const DEFAULT_PROFILES = {
  opencode: {
    name: 'OpenCode API Server',
    command: process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
    fallbackCommand: 'opencode',
    args: ['serve', '--port', '4096'],
    port: 4096,
    checkEndpoint: 'http://127.0.0.1:4096/session'
  },
  hermes: {
    name: 'Hermes Agent Gateway',
    command: process.platform === 'win32' ? 'hermes.exe' : 'hermes',
    fallbackCommand: 'hermes',
    args: ['gateway'],
    port: 8000,
    checkEndpoint: 'http://127.0.0.1:8000/v1/models'
  },
  pi: {
    name: 'Pi Coding Agent Broker',
    type: 'custom-broker'
  }
};

function getProfiles() {
  let custom = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      custom = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {}
  }
  return { ...DEFAULT_PROFILES, ...custom };
}

async function isEndpointReady(url, timeoutMs = 1000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function spawnAgent(agentName, options = {}) {
  const clean = agentName.toLowerCase().trim();
  const profiles = getProfiles();
  const profile = profiles[clean];

  if (!profile) {
    return { success: false, error: `No spawn profile found for "${clean}". Create one in agents.config.json` };
  }

  // Handle Pi broker
  if (profile.type === 'custom-broker' || clean === 'pi') {
    const spawned = tryAutoSpawnPiBroker();
    return { success: spawned, method: 'pi-broker-spawn', target: clean };
  }

  // Check if already running
  if (profile.checkEndpoint && await isEndpointReady(profile.checkEndpoint, 800)) {
    return { success: true, message: `${profile.name} is already online`, alreadyRunning: true, port: profile.port };
  }

  console.log(`🚀 [AUTO-SPAWN] Launching agent process: "${profile.name}" (${profile.command} ${profile.args.join(' ')})...`);

  try {
    const child = spawn(profile.command, profile.args, {
      detached: true,
      stdio: 'ignore',
      shell: true,
      windowsHide: !options.visible
    });
    child.unref();

    // Wait up to 5s for the port/endpoint to become ready
    const start = Date.now();
    const maxWait = options.timeoutMs || 5000;
    while (Date.now() - start < maxWait) {
      if (profile.checkEndpoint && await isEndpointReady(profile.checkEndpoint, 500)) {
        console.log(`✅ [AUTO-SPAWN READY] "${profile.name}" is now online and accepting commands!`);
        return { success: true, message: `Spawned ${profile.name} successfully`, pid: child.pid, port: profile.port };
      }
      await new Promise(r => setTimeout(r, 400));
    }

    return { success: true, message: `Spawned ${profile.name} (process started)`, pid: child.pid };
  } catch (err) {
    return { success: false, error: `Failed to spawn ${profile.name}: ${err.message}` };
  }
}

module.exports = {
  spawnAgent,
  getProfiles,
  isEndpointReady
};
