// src/index.js - Main Library Entrypoint
const config = require('./config');
const mesh = require('./core/mesh');
const server = require('./core/server');
const autowake = require('./controllers/autowake');
const piIntercom = require('./bridges/pi-intercom');
const sessionBridge = require('./bridges/session-bridge');
const mcp = require('./mcp/server');

module.exports = {
  config,
  ...mesh,
  ...server,
  ...autowake,
  ...piIntercom,
  ...sessionBridge,
  ...mcp
};
