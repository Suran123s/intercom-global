// test/run-stress-suite.js - Standalone Stress Suite Runner & Diagnostic Output
const { spawn } = require('child_process');
const path = require('path');

const tests = [
  'test/stress-concurrency.test.js',
  'test/stress-security.test.js',
  'test/stress-lock.test.js',
  'test/stress-m3-adversarial.test.js',
  'test/e2e-simulation.test.js',
  'test/concurrency.test.js',
  'test/adversarial-resilience.test.js'
];

async function run() {
  console.log('===============================================================');
  console.log('   INTERCOM-GLOBAL MASTER EMPIRICAL & E2E STRESS TEST SUITE   ');
  console.log('===============================================================\n');

  let passedAll = true;
  for (const t of tests) {
    const fullPath = path.resolve(__dirname, '..', t);
    console.log(`[SUITE] Executing: ${t}...`);
    const start = Date.now();
    const result = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [fullPath], {
        stdio: 'inherit',
        env: process.env
      });
      proc.on('close', (code) => {
        resolve({ code, duration: Date.now() - start });
      });
    });

    if (result.code === 0) {
      console.log(`[PASS] ${t} completed in ${result.duration}ms\n`);
    } else {
      console.error(`[FAIL] ${t} exited with code ${result.code} in ${result.duration}ms\n`);
      passedAll = false;
    }
  }

  console.log('===============================================================');
  console.log(`FINAL RESULT: ${passedAll ? 'ALL STRESS & E2E TESTS PASSED' : 'STRESS TESTS FAILED'}`);
  console.log('===============================================================');
  process.exit(passedAll ? 0 : 1);
}

run();
