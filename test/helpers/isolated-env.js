/**
 * test/helpers/isolated-env.js
 *
 * Shared os.tmpdir() test isolation helper ensuring test suites never pollute
 * the repository's live mesh/ directory, ~/.intercom-global/jules-ledger.json,
 * or collide on hardcoded ports / spawn background live syncs.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

/**
 * Creates an isolated temporary mesh environment and configures process.env
 * for the duration of a test or suite.
 *
 * @param {string} [prefix='intercom-test-']
 * @param {object} [options]
 * @param {number} [options.port] Optional INTERCOM_PORT override
 * @returns {{
 *   root: string,
 *   meshDir: string,
 *   ledgerFile: string,
 *   cacheFile: string,
 *   env: NodeJS.ProcessEnv,
 *   cleanup: () => void
 * }}
 */
function createIsolatedMeshEnv(prefix = 'intercom-test-', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const meshDir = path.join(root, 'mesh');
  const ledgerFile = path.join(root, 'jules-ledger.json');
  const cacheFile = path.join(root, 'purified-live-cache.json');

  fs.mkdirSync(meshDir, { recursive: true });

  const trackedKeys = [
    'INTERCOM_MESH_DIR',
    'INTERCOM_DISABLE_LIVE_SYNC',
    'JULES_LEDGER_FILE',
    'INTERCOM_SCRAPE_CACHE',
    ...(options.port !== undefined ? ['INTERCOM_PORT'] : [])
  ];
  const prevEnv = {};
  for (const k of trackedKeys) {
    prevEnv[k] = process.env[k];
  }

  process.env.INTERCOM_MESH_DIR = meshDir;
  process.env.INTERCOM_DISABLE_LIVE_SYNC = '1';
  process.env.JULES_LEDGER_FILE = ledgerFile;
  process.env.INTERCOM_SCRAPE_CACHE = cacheFile;
  if (options.port !== undefined) {
    process.env.INTERCOM_PORT = String(options.port);
  }

  const env = {
    ...process.env,
    INTERCOM_MESH_DIR: meshDir,
    INTERCOM_DISABLE_LIVE_SYNC: '1',
    JULES_LEDGER_FILE: ledgerFile,
    INTERCOM_SCRAPE_CACHE: cacheFile,
    ...(options.port !== undefined ? { INTERCOM_PORT: String(options.port) } : {})
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const k of trackedKeys) {
      if (prevEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prevEnv[k];
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  };

  return { root, meshDir, ledgerFile, cacheFile, env, cleanup };
}

/**
 * Convenience wrapper for node:test context `t` that registers automatic cleanup via `t.after`.
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix='intercom-test-']
 * @param {object} [options]
 */
function withIsolatedMeshEnv(t, prefix = 'intercom-test-', options = {}) {
  const ctx = createIsolatedMeshEnv(prefix, options);
  if (t && typeof t.after === 'function') {
    t.after(() => ctx.cleanup());
  }
  return ctx;
}

/**
 * Allocates an ephemeral free TCP port on 127.0.0.1 and closes the probe server.
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Listens on an ephemeral loopback port (port 0) and resolves to the assigned port.
 * @param {import('http').Server} server
 * @param {string} [host='127.0.0.1']
 * @returns {Promise<number>}
 */
function listenEphemeral(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onErr);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    };
    server.once('error', onErr);
    server.once('listening', onListening);
    server.listen(0, host);
  });
}

/**
 * Force-closes all active keep-alive/SSE connections and awaits server.close().
 * @param {import('http').Server | null | undefined} server
 * @returns {Promise<void>}
 */
async function closeServer(server) {
  if (!server) return;
  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch {}
  await new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Short-poll condition waiter replacing long fixed sleeps.
 * @param {() => any | Promise<any>} predicate
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function waitForCondition(predicate, { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await predicate();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

module.exports = {
  createIsolatedMeshEnv,
  withIsolatedMeshEnv,
  getFreePort,
  listenEphemeral,
  closeServer,
  waitForCondition
};
