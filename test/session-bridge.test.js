const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../src/config');
const { startSessionBridge } = require('../src/bridges/session-bridge');

test('session-bridge exports startSessionBridge function', () => {
  assert.strictEqual(typeof startSessionBridge, 'function');
});
