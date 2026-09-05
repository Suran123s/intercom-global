// test/channels-benchmark.js
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { listChannels, getChannelFile, sendChannelMessage } = require('../src/core/mesh');

function runBenchmark() {
  const NUM_CHANNELS = 50;
  const MESSAGES_PER_CHANNEL = 20;
  const channelNames = [];

  // Setup channels
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const name = `bench-channel-${i}-${Date.now()}`;
    channelNames.push(name);
    for (let j = 0; j < MESSAGES_PER_CHANNEL; j++) {
      sendChannelMessage(name, 'bench-user', `Benchmark message ${j} content for channel ${i}`);
    }
  }

  const ITERATIONS = 100;
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    listChannels();
  }
  const totalTime = performance.now() - start;
  const msPerOp = totalTime / ITERATIONS;

  console.log(`[BENCHMARK] Total time for ${ITERATIONS} listChannels calls across ${NUM_CHANNELS} channels: ${totalTime.toFixed(2)} ms`);
  console.log(`[BENCHMARK] Average time per call: ${msPerOp.toFixed(3)} ms`);

  // Cleanup
  channelNames.forEach(name => {
    const file = getChannelFile(name);
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch {}
    }
  });

  return { totalTime, msPerOp };
}

if (require.main === module) {
  runBenchmark();
}

module.exports = { runBenchmark };
