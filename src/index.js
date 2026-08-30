// src/index.js - Main Library Entrypoint
const config = require('./config');
const mesh = require('./core/mesh');
const server = require('./core/server');
const autowake = require('./controllers/autowake');
const piIntercom = require('./bridges/pi-intercom');
const sessionBridge = require('./bridges/session-bridge');
const a2a = require('./bridges/a2a');
const mcp = require('./mcp/server');

module.exports = {
  config,
  ...mesh,
  ...server,
  ...autowake,
  ...piIntercom,
  ...sessionBridge,
  ...a2a,
  ...mcp
};
