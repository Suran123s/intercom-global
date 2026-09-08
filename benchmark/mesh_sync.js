const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const benchDir = path.join(__dirname, 'temp_mesh');

function setupMeshFiles(numFiles = 50, msgsPerFile = 20) {
  if (!fs.existsSync(benchDir)) fs.mkdirSync(benchDir, { recursive: true });
  for (let i = 0; i < numFiles; i++) {
    const filename = path.join(benchDir, 'agent_' + i + '.json');
    const msgs = [];
    for (let j = 0; j < msgsPerFile; j++) {
      msgs.push({
        id: j,
        from: j % 2 === 0 ? 'alice' : 'antigravity',
        to: 'agent_' + i,
        message: 'Task message ' + j,
        timestamp: new Date().toISOString(),
        read: j % 3 === 0
      });
    }
    fs.writeFileSync(filename, JSON.stringify(msgs, null, 2), 'utf8');
  }
}

function runSyncLoopPassSync(clientName = 'antigravity') {
  const start = performance.now();
  if (!fs.existsSync(benchDir)) return performance.now() - start;
  const files = fs.readdirSync(benchDir);
  files.forEach((fileName) => {
    if (fileName.endsWith('.json')) {
      const filePath = path.join(benchDir, fileName);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let updated = false;
        data.forEach((m) => {
          if (!m.read && m.from !== clientName && !m.from.startsWith('pi:')) {
            m.read = true;
            updated = true;
          }
        });
        if (updated) {
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        }
      } catch {}
    }
  });
  return performance.now() - start;
}

async function runSyncLoopPassAsync(clientName = 'antigravity') {
  const start = performance.now();
  try {
    await fs.promises.access(benchDir);
  } catch {
    return performance.now() - start;
  }
  const files = await fs.promises.readdir(benchDir);
  await Promise.all(
    files.map(async (fileName) => {
      if (fileName.endsWith('.json')) {
        const filePath = path.join(benchDir, fileName);
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          const data = JSON.parse(content);
          let updated = false;
          data.forEach((m) => {
            if (!m.read && m.from !== clientName && !m.from.startsWith('pi:')) {
              m.read = true;
              updated = true;
            }
          });
          if (updated) {
            await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
          }
        } catch {}
      }
    })
  );
  return performance.now() - start;
}

async function runBenchmark() {
  const numFiles = 50;
  const numMsgs = 20;

  // Sync benchmark
  setupMeshFiles(numFiles, numMsgs);
  const syncBlockTime = runSyncLoopPassSync('antigravity');
  fs.rmSync(benchDir, { recursive: true, force: true });

  // Async benchmark
  setupMeshFiles(numFiles, numMsgs);
  const asyncTickStart = performance.now();
  const asyncPromise = runSyncLoopPassAsync('antigravity');
  const asyncKickoffBlockTime = performance.now() - asyncTickStart;
  const asyncTotalDuration = await asyncPromise;
  fs.rmSync(benchDir, { recursive: true, force: true });

  console.log('--- MESH SYNC BENCHMARK RESULTS ---');
  console.log('Test configuration: ' + numFiles + ' mailbox files, ' + numMsgs + ' messages/file');
  console.log('Main Thread Blocking Time (Sync):', syncBlockTime.toFixed(3), 'ms');
  console.log('Main Thread Blocking Time (Async):', asyncKickoffBlockTime.toFixed(3), 'ms');
  console.log('Main Thread Blocking Reduction:', ((1 - asyncKickoffBlockTime / syncBlockTime) * 100).toFixed(1) + '%');
  console.log('Async Concurrent Processing Duration:', asyncTotalDuration.toFixed(3), 'ms');
}

runBenchmark().catch(console.error);
