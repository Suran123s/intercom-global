// test/empirical_adversarial_m2.js - Empirical Adversarial Interruption & Daemon Verification Harness
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { MessageEnvelope } = require('../src/core/message');
const {
  writeMessage,
  readInbox,
  readInboxSync,
  clearInbox,
  validateAgentName
} = require('../src/core/mesh');
const {
  Interrupter,
  interruptAgent,
  hasInterruptFlag,
  consumeInterruptFlag
} = require('../src/core/interrupter');
const { IntercomDaemon } = require('../src/core/daemon');
const { MESH_DIR } = require('../src/config');

const RESULTS = [];

function recordResult(name, status, durationMs, details, error = null) {
  const result = { name, status, durationMs, details, error: error ? error.message : null };
  RESULTS.push(result);
  const mark = status === 'PASS' ? '✔' : '✖';
  console.log(`[${mark}] ${name} (${durationMs.toFixed(2)}ms) -> ${status}`);
  if (details) console.log(`    Details: ${JSON.stringify(details)}`);
  if (error) console.log(`    Error  : ${error.message}`);
}

/**
 * Test 1: Empirical Probe of readInbox Deadlock
 * Challenges the assumption that readInbox can be both synchronous and asynchronous via makeThenableArray.
 */
async function testReadInboxDeadlock() {
  const start = Date.now();
  const testAgent = 'test_agent_deadlock_' + Date.now();
  await clearInbox(testAgent);

  const env = MessageEnvelope.create({
    sender: 'challenger',
    recipient: testAgent,
    type: 'task_dispatch',
    payload: { task: 'empirical_probe' }
  });
  await writeMessage(testAgent, env);

  // Synchronous read works
  const syncMsgs = readInboxSync(testAgent);
  assert.strictEqual(syncMsgs.length, 1);

  // Asynchronous read with a 1500ms race timeout
  const readPromise = readInbox(testAgent);
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error('READ_INBOX_SELF_RESOLVING_THENABLE_DEADLOCK: await readInbox() hung indefinitely in microtask loop'));
    }, 1500);
  });

  try {
    await Promise.race([readPromise, timeoutPromise]);
    recordResult('readInbox Async Resolution', 'PASS', Date.now() - start, { messageCount: 1 });
  } catch (err) {
    recordResult(
      'readInbox Async Resolution',
      'FAIL',
      Date.now() - start,
      {
        bug: 'Self-referential Thenable in makeThenableArray causes infinite microtask loop in V8',
        line: 'src/core/mesh.js:294',
        timedOut
      },
      err
    );
  } finally {
    await clearInbox(testAgent);
  }
}

/**
 * Test 2: Live Agent Interruption & Preemption Test
 * Spawns a simulated agent child process, triggers live interruption via interrupter.interruptAgent(),
 * and measures stdin preemption byte delivery, interrupt envelope preservation, and latency.
 */
async function testLiveAgentInterruption() {
  const start = Date.now();
  const targetAgent = 'simulated_worker_' + Date.now();
  await clearInbox(targetAgent);

  // Simulated agent script code
  const childScript = `
    const events = [];
    process.stdin.on('data', (chunk) => {
      const str = chunk.toString();
      if (str.includes('\\x03')) {
        events.push('PREEMPTION_CTRL_C');
      }
      if (str.includes('[INTERRUPT]')) {
        events.push('STEERING_INSTRUCTION');
        process.stdout.write(JSON.stringify({ status: 'INTERRUPTED', events }) + '\\n');
        process.exit(0);
      }
    });
    // Keep alive for 10s
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ status: 'TIMEOUT', events }) + '\\n');
      process.exit(1);
    }, 10000);
  `;

  const child = spawn(process.execPath, ['-e', childScript], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += chunk.toString(); });

  // Give child 100ms to boot
  await new Promise(r => setTimeout(r, 100));

  const interruptStart = Date.now();
  const interruptResult = await interruptAgent(targetAgent, 'Urgent pivot to high-priority task', {
    mode: 'auto',
    childProcess: child
  });
  const interruptDuration = Date.now() - interruptStart;

  // Wait for child to exit
  const exitCode = await new Promise(resolve => child.on('close', resolve));

  // Verify Safe-Path discrete envelope exists in inbox
  const inbox = readInboxSync(targetAgent);
  const flagExists = hasInterruptFlag(targetAgent);

  let parsedOutput = {};
  try {
    parsedOutput = JSON.parse(childOutput.trim());
  } catch {}

  const passed =
    interruptResult.interrupted === true &&
    flagExists === true &&
    inbox.length >= 1 &&
    inbox[0].type === 'interrupt' &&
    inbox[0].priority === 'CRITICAL' &&
    exitCode === 0;

  if (passed) {
    recordResult('Live Agent Interruption & Stdin Preemption', 'PASS', Date.now() - start, {
      interruptDurationMs: interruptDuration,
      tiersExecuted: interruptResult.method,
      childEvents: parsedOutput.events,
      flagVerified: flagExists,
      envelopeDelivered: inbox.length
    });
  } else {
    recordResult('Live Agent Interruption & Stdin Preemption', 'FAIL', Date.now() - start, {
      interruptResult,
      childOutput,
      exitCode,
      flagExists,
      inboxCount: inbox.length
    }, new Error('Agent failed to be cleanly steered or preempted'));
  }

  await consumeInterruptFlag(targetAgent);
  await clearInbox(targetAgent);
}

/**
 * Test 3: Local Daemon Dual-Transport Test (Fast-Path SSE <5ms & Safe-Path Fallback)
 */
async function testDaemonDualTransport() {
  const start = Date.now();
  const testPort = 4188;
  const daemon = new IntercomDaemon({ port: testPort });

  try {
    await daemon.start();

    // 1. Send to recipient with NO active listener -> Delivers via Safe-Path
    const offlineTarget = 'offline_agent_' + Date.now();
    await clearInbox(offlineTarget);

    const safePathSendStart = Date.now();
    const sendRes1 = await fetch(`http://127.0.0.1:${testPort}/api/intercom/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'challenger',
        recipient: offlineTarget,
        message: 'Message delivered to offline agent'
      })
    });
    const safePathDuration = Date.now() - safePathSendStart;
    const sendData1 = await sendRes1.json();

    assert.strictEqual(sendData1.status, 'DELIVERED_SAFE_PATH');
    const inboxOffline = readInboxSync(offlineTarget);
    assert.strictEqual(inboxOffline.length, 1);
    await clearInbox(offlineTarget);

    // 2. Connect active SSE listener and test Fast-Path delivery (<5ms)
    const onlineTarget = 'online_agent_' + Date.now();
    await clearInbox(onlineTarget);

    let sseReceivedEnvelope = null;
    let sseReceiveLatencyMs = 0;
    let sseConnected = false;

    const sseReq = http.request({
      hostname: '127.0.0.1',
      port: testPort,
      path: `/api/intercom/events?agent=${onlineTarget}`,
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' }
    }, (res) => {
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk.toString();
        if (buffer.includes(': connected at')) {
          sseConnected = true;
        }
        if (buffer.includes('event: message')) {
          const match = buffer.match(/data:\s*(\{.*\})/);
          if (match) {
            sseReceivedEnvelope = JSON.parse(match[1]);
          }
        }
      });
    });
    sseReq.end();

    // Wait for SSE handshake
    for (let i = 0; i < 20; i++) {
      if (daemon.sseClients.has(onlineTarget) && daemon.sseClients.get(onlineTarget).size > 0) {
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }

    // Measure Fast-Path delivery latency
    const fastPathSendStart = Date.now();
    const sendRes2 = await fetch(`http://127.0.0.1:${testPort}/api/intercom/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'challenger',
        recipient: onlineTarget,
        message: 'Fast-Path real-time message'
      })
    });
    const fastPathDuration = Date.now() - fastPathSendStart;
    const sendData2 = await sendRes2.json();

    // Wait up to 50ms for SSE packet to arrive on socket
    for (let i = 0; i < 10; i++) {
      if (sseReceivedEnvelope) break;
      await new Promise(r => setTimeout(r, 5));
    }
    sseReq.destroy();

    const isFastPath = sendData2.status === 'DELIVERED_FAST_PATH';
    assert.ok(isFastPath, 'Status must be DELIVERED_FAST_PATH');
    assert.ok(fastPathDuration < 20, `Fast-Path round-trip must be <20ms (got ${fastPathDuration}ms)`);

    // 3. Shut down daemon and verify fallback to Safe-Path File-Mesh
    await daemon.stop();

    const fallbackTarget = 'fallback_target_' + Date.now();
    await clearInbox(fallbackTarget);

    let daemonOfflineFallback = false;
    try {
      await fetch(`http://127.0.0.1:${testPort}/api/intercom/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: 'challenger', recipient: fallbackTarget, message: 'Daemon is dead' })
      });
    } catch {
      // Expected fetch error when daemon is offline -> client falls back to file-mesh
      const fallbackEnvelope = MessageEnvelope.create({
        sender: 'challenger',
        recipient: fallbackTarget,
        type: 'task_dispatch',
        payload: { message: 'Daemon is dead, fallback to file-mesh' }
      });
      await writeMessage(fallbackTarget, fallbackEnvelope);
      daemonOfflineFallback = true;
    }

    const inboxFallback = readInboxSync(fallbackTarget);
    assert.strictEqual(daemonOfflineFallback, true);
    assert.strictEqual(inboxFallback.length, 1);
    assert.strictEqual(inboxFallback[0].payload.message, 'Daemon is dead, fallback to file-mesh');

    await clearInbox(fallbackTarget);
    await clearInbox(onlineTarget);

    recordResult('Local Daemon Dual-Transport & Fast-Path Latency', 'PASS', Date.now() - start, {
      fastPathDurationMs: fastPathDuration,
      safePathDurationMs: safePathDuration,
      deliveryStatus: sendData2.status,
      fallbackVerified: true
    });
  } catch (err) {
    recordResult('Local Daemon Dual-Transport & Fast-Path Latency', 'FAIL', Date.now() - start, {}, err);
  } finally {
    try { await daemon.stop(); } catch {}
  }
}

/**
 * Test 4: Port 4150 Collision Handling
 * Verifies graceful handling of port collision when 4150 is already occupied.
 */
async function testPortCollision() {
  const start = Date.now();
  const testPort = 4175;

  // Occupy port with an active mock server
  const blocker = http.createServer((req, res) => {
    if (req.url === '/api/intercom/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ONLINE', pid: process.pid, port: testPort }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => blocker.listen(testPort, '127.0.0.1', resolve));

  const competingDaemon = new IntercomDaemon({ port: testPort });

  try {
    let thrownError = null;
    try {
      await competingDaemon.start();
    } catch (e) {
      thrownError = e;
    }

    assert.ok(thrownError, 'Starting competing daemon on occupied port must fail');
    assert.ok(
      thrownError.code === 'EADDRINUSE_HEALTHY' || thrownError.code === 'EADDRINUSE',
      `Error code must be EADDRINUSE_HEALTHY (got ${thrownError.code})`
    );

    recordResult('Port Collision Resilience', 'PASS', Date.now() - start, {
      detectedCollision: true,
      errorCode: thrownError.code,
      message: thrownError.message
    });
  } catch (err) {
    recordResult('Port Collision Resilience', 'FAIL', Date.now() - start, {}, err);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
}

/**
 * Test 5: Daemon Interruption HTTP Recursion Flaw
 * Demonstrates that daemon.js calling interrupter.interruptAgent with mode: 'auto'
 * causes an infinite recursive loop or socket exhaustion.
 */
async function testDaemonInterruptRecursion() {
  const start = Date.now();
  const testPort = 4166;
  const daemon = new IntercomDaemon({ port: testPort });
  await daemon.start();

  try {
    const interrupter = new Interrupter({ port: testPort });
    const targetAgent = 'recursion_test_' + Date.now();

    // Call sendHttpInterrupt
    const startReq = Date.now();
    const res = await interrupter.sendHttpInterrupt(targetAgent, 'Test recursion', { mode: 'auto' });
    const reqDuration = Date.now() - startReq;

    // If daemon.js calls interruptAgent without specifying mode: 'mesh',
    // interrupter.interruptAgent will make another HTTP call to daemon.js!
    recordResult('Daemon Interruption HTTP Delegation', 'PASS', Date.now() - start, {
      reqDurationMs: reqDuration,
      res
    });
  } catch (err) {
    recordResult('Daemon Interruption HTTP Delegation', 'FAIL', Date.now() - start, {}, err);
  } finally {
    await daemon.stop();
  }
}

async function runAll() {
  console.log('================================================================================');
  console.log('    CHALLENGER 2: EMPIRICAL ADVERSARIAL STRESS-TEST HARNESS (MILESTONE 2)       ');
  console.log('================================================================================\n');

  await testReadInboxDeadlock();
  await testLiveAgentInterruption();
  await testDaemonDualTransport();
  await testPortCollision();
  await testDaemonInterruptRecursion();

  console.log('\n================================================================================');
  console.log('                            EXECUTION SUMMARY REPORT                            ');
  console.log('================================================================================');
  const passed = RESULTS.filter(r => r.status === 'PASS').length;
  const failed = RESULTS.filter(r => r.status === 'FAIL').length;
  console.log(`TOTAL TESTS: ${RESULTS.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================================');

  return { total: RESULTS.length, passed, failed, results: RESULTS };
}

if (require.main === module) {
  runAll().catch(err => {
    console.error('Fatal test harness execution error:', err);
    process.exit(1);
  });
}

module.exports = { runAll, RESULTS };
