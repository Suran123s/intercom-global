const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writeMessage } = require('../src/core/mesh');
const { MessageEnvelope } = require('../src/core/message');
const { withIsolatedMeshEnv } = require('./helpers/isolated-env');

test('Improvement #22: session-bridge routes discrete inbox messages to child stdin', async (t) => {
  const { root, env } = withIsolatedMeshEnv(t, 'intercom-sbridge-disc-');
  const agent = 'test-sbridge-disc-' + Date.now();
  const session = 'sess-' + Math.random().toString(36).substring(2, 8);

  const helperScript = path.join(root, `dummy_disc_${Date.now()}.js`);
  fs.writeFileSync(
    helperScript,
    [
      'const readline = require("readline");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'const timer = setTimeout(() => process.exit(1), 6000);',
      'rl.on("line", (line) => {',
      '  console.log("DISC_RECVD:" + line.trim());',
      '  clearTimeout(timer); rl.close(); process.exit(0);',
      '});'
    ].join('\n')
  );

  const bridgeProcess = spawn('node', [
    path.join(__dirname, '../src/bridges/session-bridge.js'),
    '--agent', agent,
    '--session', session,
    '--',
    'node', helperScript
  ], { env });

  let stdout = '';
  let injected = false;
  bridgeProcess.stdout.on('data', async (d) => {
    stdout += d.toString();
    if (!injected && stdout.includes('GLOBAL INTERCOM SESSION BRIDGE ACTIVE')) {
      injected = true;
      const envMsg = MessageEnvelope.create({
        sender: 'controller',
        recipient: agent,
        type: 'task_dispatch',
        payload: { message: 'execute-discrete-task' }
      });
      await writeMessage(agent, envMsg);
    }
  });

  await new Promise((resolve, reject) => {
    bridgeProcess.on('error', reject);
    bridgeProcess.on('close', (code) => {
      try {
        assert.strictEqual(code, 0);
        assert.match(stdout, /INJECTING TASK FROM CONTROLLER/);
        assert.match(stdout, /DISC_RECVD:execute-discrete-task/);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
});
