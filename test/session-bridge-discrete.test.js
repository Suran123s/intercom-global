const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writeMessage, clearInbox } = require('../src/core/mesh');
const { MessageEnvelope } = require('../src/core/message');

test('Improvement #22: session-bridge routes discrete inbox messages to child stdin', async () => {
  const agent = 'test-sbridge-disc-' + Date.now();
  const session = 'sess-' + Math.random().toString(36).substring(2, 8);

  const helperScript = path.join(__dirname, `dummy_disc_${Date.now()}.js`);
  fs.writeFileSync(
    helperScript,
    'process.stdin.on("data", d => console.log("DISC_RECVD:" + d.toString().trim())); setTimeout(() => process.exit(0), 2800);'
  );

  const bridgeProcess = spawn('node', [
    path.join(__dirname, '../src/bridges/session-bridge.js'),
    '--agent', agent,
    '--session', session,
    '--',
    'node', helperScript
  ]);

  let stdout = '';
  bridgeProcess.stdout.on('data', d => { stdout += d.toString(); });

  // Write discrete message to agent's discrete inbox
  setTimeout(async () => {
    const env = MessageEnvelope.create({
      sender: 'controller',
      recipient: agent,
      type: 'task_dispatch',
      payload: { message: 'execute-discrete-task' }
    });
    await writeMessage(agent, env);
  }, 1000);

  await new Promise((resolve, reject) => {
    bridgeProcess.on('close', async (code) => {
      try {
        assert.strictEqual(code, 0);
        assert.match(stdout, /INJECTING TASK FROM CONTROLLER/);
        assert.match(stdout, /DISC_RECVD:execute-discrete-task/);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        if (fs.existsSync(helperScript)) fs.unlinkSync(helperScript);
        try { await clearInbox(agent); } catch {}
      }
    });
  });
});
