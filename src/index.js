// src/index.js - Primary Library Exports for intercom-global
const config = require('./config');
const message = require('./core/message');
const mesh = require('./core/mesh');
const registry = require('./core/registry');
const daemon = require('./core/daemon');
const interrupter = require('./core/interrupter');
const julesDelegator = require('./core/jules-delegator');
const julesBridge = require('./bridges/jules-bridge');
const governance = require('./core/governance');
const antigravityBridge = require('./bridges/antigravity-bridge');
const cli = require('./cli');
const mcp = require('./mcp/server');

module.exports = {
  config,
  ...message,
  ...mesh,
  ...registry,
  ...daemon,
  ...interrupter,
  julesDelegator,
  julesBridge,
  antigravityBridge,
  governance,
  ...julesDelegator,
  ...governance,
  ...antigravityBridge,
  ...cli,
  ...mcp
};
