// src/bridges/jules-bridge.js - Google Jules CLI Child Process Execution Bridge
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Checks the Google Jules CLI environment (installed, authenticated, in git repo)
 * @param {object} options { dryRun: boolean }
 * @returns {Promise<{ installed: boolean, authenticated: boolean, inGitRepo: boolean, version: string, details?: object }>}
 */
async function checkJulesEnvironment(options = {}) {
  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';

  if (isDryRun) {
    return {
      installed: true,
      authenticated: true,
      inGitRepo: true,
      version: '1.0.0 (mock dry-run)',
      details: { dryRun: true }
    };
  }

  const result = {
    installed: false,
    authenticated: false,
    inGitRepo: false,
    version: 'unknown',
    details: {}
  };

  // 1. Check CLI presence
  try {
    const verOut = execSync('jules --version', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    });
    result.installed = true;
    result.version = verOut.trim();
  } catch (err) {
    result.details.installError = err.message;
    return result;
  }

  // 2. Check Git Repo Status
  try {
    const gitOut = execSync('git rev-parse --is-inside-work-tree', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    });
    result.inGitRepo = gitOut.trim() === 'true';
  } catch (err) {
    result.details.gitError = err.message;
  }

  // 3. Check Authentication Status via remote list --repo
  try {
    const repoOut = execSync('jules remote list --repo', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    });
    if (!repoOut.includes('Not logged in') && !repoOut.includes('Please login')) {
      result.authenticated = true;
    } else {
      result.details.authError = 'Not logged in to Google Jules';
    }
  } catch (err) {
    result.details.authError = err.message;
  }

  return result;
}

/**
 * Dispatches a new task session to Jules
 * @param {string} prompt Task prompt string
 * @param {object} options { repo?: string, parallel?: number, dryRun?: boolean }
 * @returns {Promise<{ sessionId: string, status: string, prompt: string, repo: string, dryRun?: boolean }>}
 */
async function newSession(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Task prompt is required for Jules dispatch');
  }

  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';

  if (isDryRun) {
    const mockId = `s_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return {
      sessionId: mockId,
      status: 'QUEUED',
      prompt: prompt.trim(),
      repo: options.repo || 'local',
      dryRun: true
    };
  }

  return new Promise((resolve, reject) => {
    const args = ['new'];
    if (options.repo) {
      args.push('--repo', options.repo);
    }
    if (options.parallel && options.parallel >= 1 && options.parallel <= 5) {
      args.push('--parallel', String(options.parallel));
    }

    const child = spawn('jules', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn jules CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`jules new failed with code ${code}: ${stderr || stdout}`));
        return;
      }

      // Parse session ID from stdout (e.g. "Created session: s_12345" or "Session ID: s_12345" or raw id)
      const idMatch = stdout.match(/(s_[a-zA-Z0-9_\-]+)/);
      const sessionId = idMatch ? idMatch[1] : `s_${Date.now()}`;

      resolve({
        sessionId,
        status: 'QUEUED',
        prompt: prompt.trim(),
        repo: options.repo || 'current',
        output: stdout.trim()
      });
    });

    // Write prompt to stdin and close stream
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Lists active and completed Jules sessions
 * @param {object} options { dryRun?: boolean }
 * @returns {Promise<Array<{ id: string, repo: string, status: string, title: string, timestamp?: string }>>}
 */
async function listSessions(options = {}) {
  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';

  if (isDryRun) {
    return options.mockSessions || [
      { id: 's_mock_1', repo: 'owner/repo', status: 'COMPLETED', title: 'Refactor test suite' }
    ];
  }

  return new Promise((resolve, reject) => {
    const child = spawn('jules', ['remote', 'list', '--session'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', err => reject(err));

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`jules remote list --session failed (code ${code}): ${stderr || stdout}`));
        return;
      }

      const sessions = parseSessionListOutput(stdout);
      resolve(sessions);
    });
  });
}

/**
 * Parses stdout from `jules remote list --session` into structured objects
 * Handles tabular format or lines with session IDs
 * @param {string} rawOutput
 * @returns {Array<{ id: string, repo: string, status: string, title: string }>}
 */
function parseSessionListOutput(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return [];

  const lines = rawOutput.split('\n').map(l => l.trim()).filter(Boolean);
  const sessions = [];

  for (const line of lines) {
    if (line.startsWith('ID') || line.startsWith('---') || line.startsWith('===')) {
      continue;
    }

    // Match session ID pattern
    const idMatch = line.match(/(s_[a-zA-Z0-9_\-]+)/);
    if (idMatch) {
      const id = idMatch[1];
      let status = 'UNKNOWN';
      const upper = line.toUpperCase();

      if (upper.includes('COMPLETED') || upper.includes('DONE')) status = 'COMPLETED';
      else if (upper.includes('PLANNING')) status = 'PLANNING';
      else if (upper.includes('EXECUTING') || upper.includes('RUNNING')) status = 'EXECUTING';
      else if (upper.includes('TESTING')) status = 'TESTING';
      else if (upper.includes('QUEUED')) status = 'QUEUED';
      else if (upper.includes('FAILED') || upper.includes('ERROR')) status = 'FAILED';

      sessions.push({
        id,
        raw: line,
        status,
        repo: 'detected'
      });
    }
  }

  return sessions;
}

/**
 * Lists connected repositories with Jules access
 * @param {object} options { dryRun?: boolean }
 * @returns {Promise<string[]>}
 */
async function listRepos(options = {}) {
  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';
  if (isDryRun) {
    return ['mock-org/intercom-global'];
  }

  try {
    const stdout = execSync('jules remote list --repo', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    });
    return stdout
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('---') && !s.startsWith('Connected'));
  } catch (err) {
    return [];
  }
}

/**
 * Pulls patch from completed Jules session
 * @param {string} sessionId
 * @param {object} options { apply: boolean, dryRun: boolean }
 * @returns {Promise<{ sessionId: string, patch: string, applied: boolean }>}
 */
async function pullSession(sessionId, options = {}) {
  if (!sessionId) throw new Error('Session ID required for pull');

  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';
  if (isDryRun) {
    return {
      sessionId,
      patch: `diff --git a/test.js b/test.js\n--- a/test.js\n+++ b/test.js\n@@ -1 +1 @@\n-old\n+new\n`,
      applied: options.apply === true
    };
  }

  const args = ['remote', 'pull', '--session', sessionId];
  if (options.apply) {
    args.push('--apply');
  }

  const stdout = execSync(`jules ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000
  });

  return {
    sessionId,
    patch: stdout,
    applied: options.apply === true
  };
}

/**
 * Teleports workspace to session branch
 * @param {string} sessionId
 * @param {object} options { dryRun: boolean }
 * @returns {Promise<{ sessionId: string, teleported: boolean }>}
 */
async function teleportSession(sessionId, options = {}) {
  if (!sessionId) throw new Error('Session ID required for teleport');

  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';
  if (isDryRun) {
    return { sessionId, teleported: true };
  }

  execSync(`jules teleport ${sessionId}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000
  });

  return { sessionId, teleported: true };
}

module.exports = {
  checkJulesEnvironment,
  newSession,
  listSessions,
  parseSessionListOutput,
  listRepos,
  pullSession,
  teleportSession
};
