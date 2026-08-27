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

// Pi Intercom Named Pipe on Windows or socket on Unix
const PI_PIPE_NAME = process.platform === 'win32'
  ? '\\\\.\\pipe\\pi-intercom-c-users-suran-pi-agent'
  : path.join(USER_HOME, '.pi', 'agent', 'intercom', 'broker.sock');

module.exports = {
  USER_HOME,
  ROOT_DIR,
  MESH_DIR,
  PORT,
  PI_PIPE_NAME
};
