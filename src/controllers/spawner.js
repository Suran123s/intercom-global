// src/controllers/spawner.js - On-Demand Dynamic Agent Process Auto-Spawner
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { tryAutoSpawnPiBroker } = require('../bridges/pi-intercom');
const { getMeshDir } = require('../config');

const UNSAFE_CMD_ARG_REGEX = /[\r\n\0&|;<>^%!]/;

function getConfigFile() {
  return path.join(path.dirname(getMeshDir()), 'agents.config.json');
}

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
  const configFile = getConfigFile();
  if (fs.existsSync(configFile)) {
    try {
      custom = JSON.parse(fs.readFileSync(configFile, 'utf8'));
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

function resolveCommandInvocation(command, args) {
  const safeArgs = Array.isArray(args) ? args.map(String) : [];
  const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));

  if (isWinBatch) {
    if (UNSAFE_CMD_ARG_REGEX.test(String(command))) {
      throw new Error(`Unsafe batch command rejected: ${command}`);
    }
    for (const arg of safeArgs) {
      if (UNSAFE_CMD_ARG_REGEX.test(arg)) {
        throw new Error(`Unsafe command argument rejected for batch shim: ${arg}`);
      }
    }
    return {
      file: process.env.ComSpec || 'cmd.exe',
      spawnArgs: ['/d', '/c', command, ...safeArgs]
    };
  }

  return {
    file: command,
    spawnArgs: safeArgs
  };
}

async function launchChild(command, args, spawnOptions) {
  const { file, spawnArgs } = resolveCommandInvocation(command, args);
  let spawnError = null;

  const child = cp.spawn(file, spawnArgs, {
    ...spawnOptions,
    shell: false
  });

  child.on('error', (err) => {
    spawnError = err;
  });

  if (typeof child.unref === 'function') {
    child.unref();
  }

  // Yield a short tick so synchronous/immediate ENOENT/EINVAL 'error' events surface before polling
  await new Promise((r) => setTimeout(r, 25));

  return { child, getError: () => spawnError };
}

async function spawnAgent(agentName, options = {}) {
  if (typeof agentName !== 'string' || !agentName.trim()) {
    return { success: false, error: 'Agent name must be a non-empty string' };
  }

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
  if (!options.force && profile.checkEndpoint && await isEndpointReady(profile.checkEndpoint, 800)) {
    return { success: true, message: `${profile.name} is already online`, alreadyRunning: true, port: profile.port };
  }

  const args = Array.isArray(profile.args) ? profile.args : [];
  console.log(`🚀 [AUTO-SPAWN] Launching agent process: "${profile.name}" (${profile.command} ${args.join(' ')})...`);

  const spawnOptions = {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: !options.visible
  };

  try {
    let launch = await launchChild(profile.command, args, spawnOptions);
    let err = launch.getError();

    if (err && (err.code === 'ENOENT' || err.code === 'EINVAL') && profile.fallbackCommand && profile.fallbackCommand !== profile.command) {
      launch = await launchChild(profile.fallbackCommand, args, spawnOptions);
      err = launch.getError();
    }

    if (err) {
      return { success: false, error: `Failed to spawn ${profile.name}: ${err.message}` };
    }

    const child = launch.child;

    // Wait up to 5s for the port/endpoint to become ready
    const start = Date.now();
    const maxWait = options.timeoutMs || 5000;
    while (Date.now() - start < maxWait) {
      if (launch.getError()) {
        const asyncErr = launch.getError();
        if ((asyncErr.code === 'ENOENT' || asyncErr.code === 'EINVAL') && profile.fallbackCommand && profile.fallbackCommand !== profile.command) {
          const fallbackLaunch = await launchChild(profile.fallbackCommand, args, spawnOptions);
          if (fallbackLaunch.getError()) {
            return { success: false, error: `Failed to spawn ${profile.name}: ${fallbackLaunch.getError().message}` };
          }
          launch = fallbackLaunch;
        } else {
          return { success: false, error: `Failed to spawn ${profile.name}: ${asyncErr.message}` };
        }
      }

      if (profile.checkEndpoint && await isEndpointReady(profile.checkEndpoint, 500)) {
        console.log(`✅ [AUTO-SPAWN READY] "${profile.name}" is now online and accepting commands!`);
        return { success: true, message: `Spawned ${profile.name} successfully`, pid: launch.child.pid, port: profile.port };
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
