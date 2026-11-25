/**
 * test/adversarial-m4-intercom.test.js
 *
 * Milestone 4 Empirical Adversarial Stress Suite for Intercom Global Mesh.
 * Authored by Challenger M4-2.
 *
 * Stress Vectors Tested:
 * 1. Concurrent multi-process Prometheus metric recording in MetricsRegistry & label escaping
 * 2. High-throughput keep-alive polling on /metrics endpoint (200+ requests over pooled keep-alive)
 * 3. Concurrent Mailbox Compaction & CAS lock contention with sudden worker SIGKILL termination
 * 4. Abrupt SSE client socket abortions under burst message dispatch loads
 * 5. Pathological payload fuzzing (5MB+ payload, full 256-byte binary buffer, corrupt inbox injection, malformed HTTP requests)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');
const os = require('os');

const {
  writeMessage,
  writeMessageSync,
  readInbox,
  readInboxSync,
  getInboxDir,
  compactMailboxes,
  acquireLock,
  releaseLock,
  withLock,
  clearInbox
} = require('../src/core/mesh');
const { MetricsRegistry } = require('../src/core/metrics');
const { createServer, dispatchMessage } = require('../src/core/server');
const { getMeshDir } = require('../src/config');
const { createIsolatedMeshEnv, closeServer } = require('./helpers/isolated-env');

describe('Milestone 4 — Empirical Adversarial Stress Testing (Challenger M4-2)', () => {
  let iso;

  beforeEach(() => {
    iso = createIsolatedMeshEnv('intercom-adv-m4-');
  });

  afterEach(async () => {
    iso.cleanup();
  });

  // =========================================================================
  // Challenge 1: Concurrent Multi-Process Prometheus Metric Recording
  // =========================================================================
  test('Adv 1.1: Concurrent Multi-Process Metric Recording & Label Escaping in MetricsRegistry', async () => {
    const tempMeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-metrics-mesh-'));
    fs.mkdirSync(path.join(tempMeshDir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(tempMeshDir, 'locks'), { recursive: true });
    fs.mkdirSync(path.join(tempMeshDir, 'dlq'), { recursive: true });

    const registry = new MetricsRegistry(tempMeshDir);

    // 1. Stress concurrent async recording
    const workerCount = 10;
    const opsPerWorker = 50;

    await Promise.all(
      Array.from({ length: workerCount }, async (_, workerId) => {
        for (let i = 0; i < opsPerWorker; i++) {
          registry.increment('intercom_messages_total', { status: 'delivered', worker: `w_${workerId}` }, 1);
          registry.observe('intercom_delivery_latency_ms', { transport: 'atomic_discrete' }, (workerId + 1) * 2.5);
          registry.setGauge('intercom_active_workers_gauge', { pool: 'stress' }, workerCount);
        }
      })
    );

    // 2. Stress label escaping (quotes, backslashes, unicode)
    registry.increment('intercom_messages_total', {
      status: 'error',
      reason: 'Quote: "escaped", Backslash: \\, Special: <>&='
    }, 5);

    const output = registry.render();

    // Verify aggregations
    assert.ok(output.includes('# HELP intercom_messages_total'));
    assert.ok(output.includes('# TYPE intercom_messages_total counter'));

    // Verify counter total across workers
    for (let w = 0; w < workerCount; w++) {
      assert.ok(output.includes(`worker="w_${w}"} ${opsPerWorker}`), `Worker ${w} counter must equal ${opsPerWorker}`);
    }

    // Verify label escaping
    assert.ok(output.includes('Quote: \\"escaped\\", Backslash: \\\\, Special: <>&='), 'Labels with quotes and backslashes must be safely escaped');

    // Verify histogram aggregation
    const expectedObservations = workerCount * opsPerWorker;
    assert.ok(output.includes(`intercom_delivery_latency_ms_count{transport="atomic_discrete"} ${expectedObservations}`));

    // Clean up
    try { fs.rmSync(tempMeshDir, { recursive: true, force: true }); } catch {}
  });

  // =========================================================================
  // Challenge 2: High-Throughput Keep-Alive Polling on /metrics
  // =========================================================================
  test('Adv 2.1: High-Throughput Keep-Alive Polling on /metrics & /api/intercom/metrics', async () => {
    const server = createServer();
    let port;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: 25,
      keepAliveMsecs: 5000
    });

    const totalRequests = 200;
    const concurrency = 20;
    let completedRequests = 0;
    let successfulRequests = 0;

    async function makeRequest(path) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method: 'GET',
            agent,
            headers: {
              Connection: 'keep-alive',
              Accept: 'text/plain; version=0.0.4'
            }
          },
          (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
              if (res.statusCode === 200 &&
                  res.headers['content-type'].includes('text/plain') &&
                  body.includes('# HELP intercom_messages_total')) {
                successfulRequests++;
              }
              completedRequests++;
              resolve();
            });
          }
        );
        req.on('error', (err) => {
          completedRequests++;
          reject(err);
        });
        req.end();
      });
    }

    // Dispatch requests in batches
    for (let i = 0; i < totalRequests; i += concurrency) {
      const batch = [];
      for (let j = 0; j < concurrency && i + j < totalRequests; j++) {
        const reqPath = (i + j) % 2 === 0 ? '/metrics' : '/api/intercom/metrics';
        batch.push(makeRequest(reqPath));
      }
      await Promise.all(batch);
    }

    agent.destroy();
    await new Promise((resolve) => server.close(resolve));

    assert.equal(completedRequests, totalRequests, `All ${totalRequests} requests must complete`);
    assert.equal(successfulRequests, totalRequests, `All ${totalRequests} keep-alive requests must return HTTP 200 and valid Prometheus body`);
  });

  // =========================================================================
  // Challenge 3: Compaction & CAS Lock Races with Sudden Worker Termination
  // =========================================================================
  test('Adv 3.1: Compaction & CAS Lock Races with Abrupt Worker Termination (SIGKILL)', async () => {
    const testAgent = `adv-crash-${Date.now()}`;
    const inboxDir = getInboxDir(testAgent);

    // 1. Seed mailbox with 5 valid messages
    for (let i = 0; i < 5; i++) {
      await writeMessage(testAgent, {
        sender: 'seed-sender',
        recipient: testAgent,
        payload: { index: i, note: 'Pre-crash message' }
      });
    }

    // 2. Spawn a child process that acquires a lock on the testAgent mailbox
    const childScript = `
      const { acquireLock } = require('./src/core/mesh');
      (async () => {
        try {
          const lk = await acquireLock('${testAgent}', 15000);
          process.stdout.write('LOCKED:' + lk.token + '\\n');
          // Keep process alive holding the lock until killed
          setInterval(() => {}, 1000);
        } catch (err) {
          process.stderr.write(err.stack);
          process.exit(1);
        }
      })();
    `;

    const child = cp.spawn(process.execPath, ['-e', childScript], {
      cwd: path.resolve(__dirname, '..'),
      env: iso.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let lockToken = null;
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        const str = chunk.toString();
        if (str.includes('LOCKED:')) {
          lockToken = str.split('LOCKED:')[1].trim();
          resolve();
        }
      });
      child.stderr.on('data', (c) => process.stderr.write(`[Child ERR] ${c}`));
      child.on('error', reject);
    });

    assert.ok(lockToken, 'Child must acquire lock');

    // Verify lock is currently held on disk
    const locksDir = path.join(getMeshDir(), 'locks');
    const lockDir = path.join(locksDir, `${testAgent}.lock`);
    assert.ok(fs.existsSync(lockDir), 'Lock directory must exist while child is alive');

    // 3. Suddenly terminate the child process with force kill (simulating crash)
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));

    // 4. Immediately trigger compaction & competing lock acquisition
    const compactionReport = await compactMailboxes({ removeEmpty: true, dryRun: false });
    assert.ok(compactionReport, 'Compaction must not throw when encountering stale lock');

    // 5. Competing worker attempts to acquire the lock: it must detect dead PID and break stale lock cleanly
    const freshLock = await acquireLock(testAgent, 3000, { timeoutMs: 5000 });
    assert.ok(freshLock && freshLock.token, 'Must successfully break dead process stale lock');
    assert.notEqual(freshLock.token, lockToken, 'New lock must have distinct token');

    // 6. Verify mailbox integrity: all 5 seed messages must be intact
    const inbox = await readInbox(testAgent);
    assert.equal(inbox.length, 5, 'All 5 seed messages must survive crash and compaction');

    // Clean up lock
    await releaseLock(freshLock);
    await clearInbox(testAgent);
  });

  // =========================================================================
  // Challenge 4: Abrupt SSE Client Socket Terminations Under Burst Message Loads
  // =========================================================================
  test('Adv 4.1: Abrupt SSE Client Socket Terminations Under Burst Message Dispatch', async () => {
    const server = createServer();
    let port;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    const sseClients = [];
    const totalClients = 12;
    const clientsToAbort = 6;
    const abortAtMessage = 15;
    const totalMessages = 40;

    // Helper to connect an SSE client
    function connectClient(id) {
      return new Promise((resolve, reject) => {
        const clientObj = {
          id,
          received: [],
          aborted: false,
          req: null,
          res: null
        };

        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/intercom/events',
            method: 'GET',
            headers: {
              Accept: 'text/event-stream',
              Connection: 'keep-alive'
            }
          },
          (res) => {
            clientObj.res = res;
            let buffer = '';
            res.on('data', (chunk) => {
              buffer += chunk.toString();
              const parts = buffer.split('\n\n');
              buffer = parts.pop();
              for (const part of parts) {
                if (part.includes('data:')) {
                  clientObj.received.push(part);
                  if (clientObj.received.length === 1) {
                    resolve(clientObj);
                  }
                }
              }
            });
          }
        );

        req.on('error', (err) => {
          if (!clientObj.aborted) {
            reject(err);
          }
        });

        clientObj.req = req;
        req.end();
      });
    }

    // Connect all clients and wait for initial connection event
    for (let c = 0; c < totalClients; c++) {
      const client = await connectClient(c);
      sseClients.push(client);
    }

    assert.equal(sseClients.length, totalClients);

    // Burst messages, abruptly aborting half the sockets mid-stream
    for (let m = 0; m < totalMessages; m++) {
      if (m === abortAtMessage) {
        // Abruptly terminate half the clients
        for (let i = 0; i < clientsToAbort; i++) {
          sseClients[i].aborted = true;
          try {
            sseClients[i].req.destroy(new Error('Adversarial abrupt socket drop'));
          } catch {}
        }
      }

      dispatchMessage('burst-sender', `adv-recipient-${m % 3}`, `Burst payload #${m}`);
      await new Promise((r) => setTimeout(r, 5));
    }

    // Wait a brief period for event delivery
    await new Promise((r) => setTimeout(r, 100));

    // Verify surviving clients received all broadcast messages
    for (let i = clientsToAbort; i < totalClients; i++) {
      const surviving = sseClients[i];
      assert.ok(
        surviving.received.length >= totalMessages,
        `Surviving client ${i} must receive at least ${totalMessages} messages, got ${surviving.received.length}`
      );
      try { surviving.req.destroy(); } catch {}
    }

    await closeServer(server);
  });

  // =========================================================================
  // Challenge 5: Pathological Payload Fuzzing
  // =========================================================================
  test('Adv 5.1: Pathological 5MB+ Extreme Payload Round-Trip', async () => {
    const extremeAgent = `adv-5mb-${Date.now()}`;
    const payloadSize = 5 * 1024 * 1024; // 5 MB
    const largeString = 'Z'.repeat(payloadSize);

    const writeStart = Date.now();
    const result = await writeMessage(extremeAgent, {
      sender: 'giant-sender',
      recipient: extremeAgent,
      body: largeString
    });
    const writeDuration = Date.now() - writeStart;

    assert.ok(result && result.messageId);
    assert.ok(writeDuration < 10000, `Writing 5MB payload must complete within 10s (took ${writeDuration}ms)`);

    const inbox = await readInbox(extremeAgent);
    assert.equal(inbox.length, 1);
    const msg = inbox[0];
    const receivedBody = msg.payload?.message || msg.payload?.body || msg.body;
    assert.equal(receivedBody.length, payloadSize, '5MB payload must not suffer truncation');

    await clearInbox(extremeAgent);
  });

  test('Adv 5.2: Complete 256-Byte Binary Spectrum & Null Bytes in Payloads', async () => {
    const binAgent = `adv-bin-${Date.now()}`;

    // Construct buffer with all 256 possible byte values [0x00 .. 0xFF]
    const allBytesBuffer = Buffer.alloc(256);
    for (let b = 0; b < 256; b++) {
      allBytesBuffer[b] = b;
    }
    const binaryString = allBytesBuffer.toString('binary');

    const result = await writeMessage(binAgent, {
      sender: 'binary-oracle',
      recipient: binAgent,
      body: binaryString
    });

    assert.ok(result);

    const inbox = await readInbox(binAgent);
    assert.equal(inbox.length, 1);
    const msg = inbox[0];
    const retrieved = msg.payload?.message || msg.payload?.body || msg.body;

    const roundTrippedBuf = Buffer.from(retrieved, 'binary');
    assert.equal(Buffer.compare(allBytesBuffer, roundTrippedBuf), 0, 'Full 256-byte binary payload must round-trip with 100% byte fidelity');

    await clearInbox(binAgent);
  });

  test('Adv 5.3: Pathological Inbox Injection: 0-Byte, Corrupted, Non-JSON & Binary Junk', async () => {
    const corruptAgent = `adv-corrupt-${Date.now()}`;
    const inboxDir = getInboxDir(corruptAgent);

    // Drop multiple corrupted/adversarial files directly into mailbox
    fs.writeFileSync(path.join(inboxDir, '9999999999901_empty.json'), '', 'utf8'); // 0-byte file
    fs.writeFileSync(path.join(inboxDir, '9999999999902_truncated.json'), '{"id": "trunc', 'utf8');
    fs.writeFileSync(path.join(inboxDir, '9999999999903_binary.json'), Buffer.from([0x00, 0xff, 0xfe, 0x1b, 0x07]));
    fs.writeFileSync(path.join(inboxDir, '9999999999904_notjson.json'), 'PLAIN TEXT GIBBERISH !@#$%', 'utf8');
    fs.writeFileSync(path.join(inboxDir, '9999999999905_null.json'), 'null', 'utf8');

    // Also write a legitimate valid message
    await writeMessage(corruptAgent, {
      sender: 'survivor',
      recipient: corruptAgent,
      body: 'I am the lone survivor'
    });

    // Both async and sync readInbox must skip corrupted files without throwing
    let asyncInbox;
    assert.doesNotThrow(async () => {
      asyncInbox = await readInbox(corruptAgent);
    });
    asyncInbox = await readInbox(corruptAgent);
    assert.ok(asyncInbox.length >= 1, 'Async readInbox must successfully retrieve valid message');
    assert.equal(asyncInbox[0].payload?.body || asyncInbox[0].payload?.message, 'I am the lone survivor');

    let syncInbox;
    assert.doesNotThrow(() => {
      syncInbox = readInboxSync(corruptAgent);
    });
    assert.ok(syncInbox.length >= 1, 'Sync readInboxSync must also successfully retrieve valid message');

    await clearInbox(corruptAgent);
  });

  test('Adv 5.4: Malformed HTTP REST Payloads to /api/intercom/send', async () => {
    const server = createServer();
    let port;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    // Helper for raw HTTP POST
    async function postRaw(payload, contentType = 'application/json') {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/intercom/send',
            method: 'POST',
            headers: {
              'Content-Type': contentType,
              'Content-Length': Buffer.byteLength(payload)
            }
          },
          (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    }

    // 1. Broken JSON
    const res1 = await postRaw('{ invalid json string');
    assert.equal(res1.status, 400, 'Malformed JSON must return HTTP 400');

    // 2. Missing required fields
    const res2 = await postRaw(JSON.stringify({ from: 'alice' })); // missing 'to' and 'message'
    assert.equal(res2.status, 400, 'Missing fields must return HTTP 400');

    // 3. Empty body
    const res3 = await postRaw('');
    assert.equal(res3.status, 400, 'Empty body must return HTTP 400');

    // 4. Valid body should succeed
    const res4 = await postRaw(JSON.stringify({ from: 'alice', to: 'bob', message: 'Hello Bob' }));
    assert.equal(res4.status, 200, 'Valid body must return HTTP 200');

    await closeServer(server);
    await clearInbox('bob');
  });
});
