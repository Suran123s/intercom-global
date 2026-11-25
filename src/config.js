// src/config.js - Central Configuration & Environment Resolver
const path = require('path');
const os = require('os');
const fs = require('fs');

const USER_HOME = os.homedir();
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_PORT = 4150;

/**
 * Resolves the active mesh directory dynamically from INTERCOM_MESH_DIR or default ROOT_DIR/mesh.
 * @returns {string}
 */
function getMeshDir() {
  const configured = process.env.INTERCOM_MESH_DIR && process.env.INTERCOM_MESH_DIR.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.join(ROOT_DIR, 'mesh');
}

/**
 * Resolves the active daemon HTTP port dynamically from INTERCOM_PORT with numeric validation.
 * @returns {number}
 */
function getPort() {
  const raw = process.env.INTERCOM_PORT;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const parsed = parseInt(String(raw).trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
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

module.exports = {
  USER_HOME,
  ROOT_DIR,
  getMeshDir,
  getPort,
  getAgentDirPath,
  getBrokerConnectTarget,
  get MESH_DIR() {
    return getMeshDir();
  },
  get PORT() {
    return getPort();
  },
  get PI_PIPE_NAME() {
    return getBrokerConnectTarget();
  }
};
