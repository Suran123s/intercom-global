// test/e2e-opencode-hermes.js - Live Verification of OpenCode & Hermes Multi-Agent Communication
const http = require('http');
const assert = require('assert');
const { createIsolatedMeshEnv, listenEphemeral, closeServer } = require('./helpers/isolated-env');

async function runVerification() {
  const iso = createIsolatedMeshEnv('intercom-e2e-');
  const prevOpencodePort = process.env.OPENCODE_PORT;
  const prevHermesPort = process.env.HERMES_PORT;
  const prevOpencodeUrl = process.env.OPENCODE_URL;
  const prevHermesUrl = process.env.HERMES_URL;

  let opencodeServer;
  let hermesServer;

  try {
    console.log('🧪 [STARTING LIVE VERIFICATION OF OPENCODE & HERMES AGENT MESH]...\n');

    let opencodePromptReceived = null;
    let hermesPromptReceived = null;

    // 1. Start Mock OpenCode Server on ephemeral port
    opencodeServer = http.createServer((req, res) => {
      if (req.url === '/session' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([{ id: 'opencode-main-session' }]));
      }
      if (req.url === '/session/opencode-main-session/prompt_async' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          opencodePromptReceived = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'queued', sessionId: 'opencode-main-session' }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const opencodePort = await listenEphemeral(opencodeServer);
    console.log(`✅ 1. Mock OpenCode Server active on http://127.0.0.1:${opencodePort}`);

    // 2. Start Mock Hermes Gateway on ephemeral port
    hermesServer = http.createServer((req, res) => {
      if (req.url === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'hermes' }] }));
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          hermesPromptReceived = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'chatcmpl-hermes', choices: [{ message: { content: 'Task received by Hermes' } }] }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const hermesPort = await listenEphemeral(hermesServer);
    console.log(`✅ 2. Mock Hermes Gateway active on http://127.0.0.1:${hermesPort}`);

    process.env.OPENCODE_PORT = String(opencodePort);
    process.env.HERMES_PORT = String(hermesPort);
    process.env.OPENCODE_URL = `http://127.0.0.1:${opencodePort}`;
    process.env.HERMES_URL = `http://127.0.0.1:${hermesPort}`;

    const { wakeAgent, diagnoseMesh } = require('../src/controllers/autowake');
    const { sendChannelMessage, readChannel, broadcastToAgents } = require('../src/core/mesh');
    const { dispatchMessage } = require('../src/core/server');

    // 3. Test Doctor Diagnostics with both online
    console.log('\n🔍 3. Probing mesh health via diagnoseMesh()...');
    const health = await diagnoseMesh();
    console.log(`- OpenCode API Status : ${health.services.opencodeApi.status} (Active Sessions: ${health.services.opencodeApi.activeSessions})`);
    console.log(`- Hermes Gateway Status: ${health.services.hermesGateway.status}`);
    assert.strictEqual(health.services.opencodeApi.status, 'ONLINE');
    assert.strictEqual(health.services.hermesGateway.status, 'ONLINE');

    // 4. Test AutoWake Prompt Injection into OpenCode
    console.log('\n⚡ 4. Sending Auto-Wake Prompt Injection to OpenCode...');
    await new Promise(resolve => {
      wakeAgent('opencode', 'Refactor auth middleware and run tests', (report) => {
        assert.strictEqual(report.channels.opencode.delivered, true);
        assert.strictEqual(report.channels.opencode.session, 'opencode-main-session');
        assert.ok(opencodePromptReceived);
        assert.ok(opencodePromptReceived.prompt.includes('Refactor auth middleware'));
        console.log('   ✔ OpenCode received live asynchronous prompt injection successfully!');
        resolve();
      });
    });

    // 5. Test AutoWake Prompt Injection into Hermes Agent
    console.log('\n⚡ 5. Sending Auto-Wake Prompt Injection to Hermes Agent...');
    await new Promise(resolve => {
      wakeAgent('hermes', 'Audit security headers across API endpoints', (report) => {
        assert.strictEqual(report.channels.hermes.delivered, true);
        assert.ok(hermesPromptReceived);
        assert.ok(hermesPromptReceived.messages[0].content.includes('Audit security headers'));
        console.log('   ✔ Hermes Gateway received live task completion request successfully!');
        resolve();
      });
    });

    // 6. Test Multi-Agent Swarm Broadcast
    console.log('\n📢 6. Testing 1-to-Many Swarm Broadcast to OpenCode, Hermes, and Pal...');
    const broadcastResults = await broadcastToAgents('suran', 'opencode,hermes,pal', 'Sync release build v1.0.0', dispatchMessage);
    assert.strictEqual(broadcastResults.length, 3);
    console.log(`   ✔ Broadcast delivered to: ${broadcastResults.map(r => r.to).join(', ')}`);

    // 7. Test Topic Channel Pub-Sub
    const chanName = 'agent-collab-' + Date.now();
    console.log(`\n💬 7. Testing Topic Channel (#${chanName}) Pub-Sub...`);
    sendChannelMessage(chanName, 'opencode', 'Frontend components compiled cleanly');
    sendChannelMessage(chanName, 'hermes', 'Security analysis: 0 vulnerabilities found');
    sendChannelMessage(chanName, 'suran', 'Ready to merge PR');

    const channelHistory = readChannel(chanName);
    assert.strictEqual(channelHistory.length, 3);
    console.log(`   ✔ Channel #${chanName} contains all 3 messages from OpenCode, Hermes, and Suran`);

    console.log('\n🎉 [ALL LIVE VERIFICATIONS PASSED 100% SUCCESFULLY!]');
  } finally {
    await closeServer(opencodeServer);
    await closeServer(hermesServer);
    if (prevOpencodePort === undefined) delete process.env.OPENCODE_PORT; else process.env.OPENCODE_PORT = prevOpencodePort;
    if (prevHermesPort === undefined) delete process.env.HERMES_PORT; else process.env.HERMES_PORT = prevHermesPort;
    if (prevOpencodeUrl === undefined) delete process.env.OPENCODE_URL; else process.env.OPENCODE_URL = prevOpencodeUrl;
    if (prevHermesUrl === undefined) delete process.env.HERMES_URL; else process.env.HERMES_URL = prevHermesUrl;
    iso.cleanup();
  }
}

runVerification().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
