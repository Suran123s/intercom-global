const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const testDir = path.join(__dirname, 'mesh_bench_temp');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

// Create 200 mailbox files with 100 messages each
for (let i = 0; i < 200; i++) {
  const msgs = Array.from({ length: 100 }, (_, j) => ({
    id: j,
    from: 'agent_' + (j % 5),
    to: 'agent_' + i,
    message: 'Test message body ' + j,
    read: j % 3 === 0
  }));
  fs.writeFileSync(path.join(testDir, `agent_${i}.json`), JSON.stringify(msgs));
}

process.env.INTERCOM_MESH_DIR = testDir;
const { listActiveMailboxes } = require('../src/core/mesh');

async function runBenchmark() {
  // Warm up
  await listActiveMailboxes();

  const iterations = 10;
  const times = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = await listActiveMailboxes();
    const end = performance.now();
    times.push(end - start);
  }

  const avg = times.reduce((a, b) => a + b, 0) / iterations;
  console.log(`[BENCHMARK] Average execution time over ${iterations} runs: ${avg.toFixed(2)} ms`);
  console.log(`[BENCHMARK] Min: ${Math.min(...times).toFixed(2)} ms, Max: ${Math.max(...times).toFixed(2)} ms`);

  fs.rmSync(testDir, { recursive: true, force: true });
}

runBenchmark();
