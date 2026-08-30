// src/config.js - Central Configuration & Environment Resolver
const path = require('path');
const os = require('os');
const fs = require('fs');

const USER_HOME = os.homedir();
const ROOT_DIR = path.resolve(__dirname, '..');
const MESH_DIR = process.env.INTERCOM_MESH_DIR || path.join(ROOT_DIR, 'mesh');
const PORT = process.env.INTERCOM_PORT || 4150;

// Ensure mesh directory exists
if (!fs.existsSync(MESH_DIR)) {
  fs.mkdirSync(MESH_DIR, { recursive: true });
}

function sanitizePipeSegment(value) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'default';
}

function getAgentDirPath() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return path.join(USER_HOME, '.pi', 'agent');
  }
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function getBrokerConnectTarget() {
  const agentDir = getAgentDirPath();
  const intercomDir = path.join(agentDir, 'intercom');

  // Check if TCP mode is configured or port file exists
  const isTcp = (process.platform === 'win32' && (process.env.PI_INTERCOM_TRANSPORT === 'tcp' || process.env.PI_INTERCOM_TCP === '1' || process.env.PI_INTERCOM_TCP === 'true'));
  const portFile = path.join(intercomDir, 'broker.port.json');

  if (isTcp && fs.existsSync(portFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(portFile, 'utf8'));
      if (parsed && parsed.host && parsed.port) {
        return { host: parsed.host, port: parsed.port };
      }
    } catch {}
  }

  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }

  return path.join(intercomDir, 'broker.sock');
}

const PI_PIPE_NAME = getBrokerConnectTarget();

module.exports = {
  USER_HOME,
  ROOT_DIR,
  MESH_DIR,
  PORT,
  getAgentDirPath,
  getBrokerConnectTarget,
  PI_PIPE_NAME
};

