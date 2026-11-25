// test/stress-concurrency.test.js - Empirical Concurrency Stress Harness
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { MessageEnvelope } = require('../src/core/message');
const { writeMessage, readInbox, clearInbox, getInboxDir } = require('../src/core/mesh');

if (!isMainThread) {
  // Worker Thread Execution
  const { workerId, recipient, messageCount, meshDir } = workerData;
  if (meshDir) {
    process.env.INTERCOM_MESH_DIR = meshDir;
  }
  (async () => {
    const results = [];
    for (let i = 0; i < messageCount; i++) {
      const envelope = MessageEnvelope.create({
        sender: `worker_agent_${workerId}`,
        recipient,
        type: 'task_dispatch',
        priority: 'NORMAL',
        payload: {
          workerId,
          seq: i,
          sentAt: Date.now(),
          token: `token_${workerId}_${i}`
        }
      });
      const res = await writeMessage(recipient, envelope);
      results.push({ messageId: res.messageId, seq: i });
    }
    parentPort.postMessage({ workerId, success: true, count: results.length, results });
  })().catch(err => {
    parentPort.postMessage({ workerId, success: false, error: err.message });
  });
} else {
  // Main Thread Test Suite
  const { withIsolatedMeshEnv } = require('./helpers/isolated-env');
  test('Empirical Concurrency Stress: 12 concurrent workers writing to same recipient inbox', async (t) => {
    const { meshDir } = withIsolatedMeshEnv(t, 'intercom-stress-conc-');
    const RECIPIENT = 'stress_concurrency_agent_' + Date.now();
    const NUM_WORKERS = 12;
    const MSGS_PER_WORKER = 10;
    const EXPECTED_TOTAL = NUM_WORKERS * MSGS_PER_WORKER; // 120 messages

    await clearInbox(RECIPIENT);
    const inboxDir = getInboxDir(RECIPIENT);

    const startTime = Date.now();

    // Spawn 12 simultaneous worker threads
    const workerPromises = [];
    for (let w = 0; w < NUM_WORKERS; w++) {
      workerPromises.push(new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
          workerData: {
            workerId: w,
            recipient: RECIPIENT,
            messageCount: MSGS_PER_WORKER,
            meshDir
          }
        });
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Worker ${w} stopped with exit code ${code}`));
        });
      }));
    }

    const workerResults = await Promise.all(workerPromises);
    const totalTimeMs = Date.now() - startTime;

    // 1. Verify all worker processes reported 100% success
    for (const wr of workerResults) {
      assert.strictEqual(wr.success, true, `Worker ${wr.workerId} failed: ${wr.error}`);
      assert.strictEqual(wr.count, MSGS_PER_WORKER);
    }

    // 2. Inspect physical files on disk
    const diskFiles = fs.readdirSync(inboxDir);
    const messageFiles = diskFiles.filter(f => /^\d+_[a-zA-Z0-9\-]+\.json$/.test(f));
    const tmpFiles = diskFiles.filter(f => f.endsWith('.tmp'));

    assert.strictEqual(tmpFiles.length, 0, `Found dangling .tmp files: ${tmpFiles.join(', ')}`);
    assert.strictEqual(messageFiles.length, EXPECTED_TOTAL, `Expected ${EXPECTED_TOTAL} files on disk, found ${messageFiles.length}`);

    // 3. Verify zero corrupted JSON files
    let corruptedFiles = 0;
    for (const f of messageFiles) {
      try {
        const content = fs.readFileSync(path.join(inboxDir, f), 'utf8');
        const parsed = JSON.parse(content);
        assert.ok(parsed.id, 'Message missing id');
        assert.ok(parsed.payload, 'Message missing payload');
      } catch (err) {
        corruptedFiles++;
      }
    }
    assert.strictEqual(corruptedFiles, 0, `Found ${corruptedFiles} corrupted JSON files`);

    // 4. Verify 100% delivery through readInbox API
    const delivered = await readInbox(RECIPIENT);
    assert.strictEqual(delivered.length, EXPECTED_TOTAL, `API read expected ${EXPECTED_TOTAL}, got ${delivered.length}`);

    // 5. Verify 0 messages lost: check every workerId and seq combination
    const receivedMap = new Map();
    for (const msg of delivered) {
      const key = `${msg.payload.workerId}_${msg.payload.seq}`;
      assert.ok(!receivedMap.has(key), `Duplicate message detected for key ${key}`);
      receivedMap.set(key, msg);
    }

    for (let w = 0; w < NUM_WORKERS; w++) {
      for (let s = 0; s < MSGS_PER_WORKER; s++) {
        const key = `${w}_${s}`;
        assert.ok(receivedMap.has(key), `Message lost: Worker ${w}, Seq ${s}`);
      }
    }

    // Output performance metrics
    const throughput = ((EXPECTED_TOTAL / totalTimeMs) * 1000).toFixed(2);
    console.log(`[CONCURRENCY STRESS] Delivered: ${delivered.length}/${EXPECTED_TOTAL} (100%) | Corrupted: 0 | Lost: 0 | Time: ${totalTimeMs}ms (${throughput} msgs/sec)`);

    await clearInbox(RECIPIENT);
  });
}
