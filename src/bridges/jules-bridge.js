// src/bridges/jules-bridge.js - Google Jules CLI Child Process Execution Bridge
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SESSION_ID_REGEX = /^s_[a-zA-Z0-9_-]+$/;
const SAFE_REPO_REGEX = /^[a-zA-Z0-9_.\-/]+$/;
const CMD_META_REGEX = /[&|<>^%!"\r\n\0]/;

/**
 * Validates a Jules session ID against the strict identifier pattern.
 * @param {string} sessionId
 * @param {string} [action='operation']
 * @returns {string}
 */
function validateSessionId(sessionId, action = 'operation') {
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error(`Session ID required for ${action}`);
  }
  const trimmed = sessionId.trim();
  if (!SESSION_ID_REGEX.test(trimmed)) {
    throw new Error(`Invalid Jules session ID: "${trimmed}"`);
  }
  return trimmed;
}

/**
 * Resolves CLI executable safely on Windows without invoking an unrestricted shell.
 * On Windows, Node >=18.20.2 / 20.12.2+ rejects spawning .cmd/.bat directly with shell: false;
 * when a .cmd/.bat shim is resolved, arguments are validated against cmd metacharacters and
 * passed to cmd.exe /d /c with shell: false.
 * @param {string} command
 * @param {string[]} args
 * @returns {{ file: string, args: string[] }}
 */
function resolveCommandInvocation(command, args = []) {
  if (process.platform !== 'win32') {
    return { file: command, args };
  }

  const hasSep = command.includes('\\') || command.includes('/');
  const pathEntries = hasSep ? [''] : (process.env.PATH || '').split(';').filter(Boolean);
  const hasExt = /\.[a-zA-Z0-9]+$/.test(command);
  const exts = hasExt ? [''] : ['.exe', '.cmd', '.bat', '.com'];

  let resolvedPath = null;
  for (const dir of pathEntries) {
    for (const ext of exts) {
      const candidate = hasSep ? `${command}${ext}` : path.join(dir, `${command}${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          resolvedPath = candidate;
          break;
        }
      } catch {}
    }
    if (resolvedPath) break;
  }

  if (resolvedPath && /\.(cmd|bat)$/i.test(resolvedPath)) {
    for (const arg of args) {
      if (typeof arg !== 'string' || CMD_META_REGEX.test(arg)) {
        throw new Error(`Unsafe CLI argument rejected for Windows shim execution`);
      }
    }
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', resolvedPath, ...args]
    };
  }

  return { file: resolvedPath || command, args };
}

/**
 * Promisified execFile with shell disabled and Windows window hiding.
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function execFileAsync(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let invocation;
    try {
      invocation = resolveCommandInvocation(command, args);
    } catch (err) {
      reject(err);
      return;
    }

    execFile(
      invocation.file,
      invocation.args,
      {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: options.timeout ?? 5000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      }
    );
  });
}

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
    const { stdout: verOut } = await execFileAsync('jules', ['--version'], { timeout: 3000 });
    result.installed = true;
    result.version = verOut.trim();
  } catch (err) {
    result.details.installError = err.message;
    return result;
  }

  // 2. Check Git Repo Status
  try {
    const { stdout: gitOut } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { timeout: 2000 });
    result.inGitRepo = gitOut.trim() === 'true';
  } catch (err) {
    result.details.gitError = err.message;
  }

  // 3. Check Authentication Status via remote list --repo
  try {
    const { stdout: repoOut } = await execFileAsync('jules', ['remote', 'list', '--repo'], { timeout: 5000 });
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
 * @param {object} options { repo?: string, parallel?: number, dryRun?: boolean, timeoutMs?: number }
 * @returns {Promise<{ sessionId: string, status: string, prompt: string, repo: string, dryRun?: boolean }>}
 */
async function newSession(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Task prompt is required for Jules dispatch');
  }

  if (options.repo !== undefined && options.repo !== null) {
    if (typeof options.repo !== 'string' || !SAFE_REPO_REGEX.test(options.repo.trim())) {
      throw new Error(`Invalid repository identifier: "${options.repo}"`);
    }
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

  const cliArgs = ['new'];
  if (options.repo) {
    cliArgs.push('--repo', options.repo.trim());
  }
  if (options.parallel && options.parallel >= 1 && options.parallel <= 5) {
    cliArgs.push('--parallel', String(Math.floor(options.parallel)));
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000;

  return new Promise((resolve, reject) => {
    let invocation;
    try {
      invocation = resolveCommandInvocation('jules', cliArgs);
    } catch (err) {
      reject(err);
      return;
    }

    const child = spawn(invocation.file, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(new Error(`jules new timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Prevent unhandled EPIPE if child exits before stdin finishes writing
      });
    }

    child.on('error', (err) => {
      finish(new Error(`Failed to spawn jules CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`jules new failed with code ${code}: ${stderr || stdout}`));
        return;
      }

      // Parse session ID from stdout (e.g. "Created session: s_12345" or "Session ID: s_12345" or raw id)
      const idMatch = stdout.match(/(s_[a-zA-Z0-9_\-]+)/);
      if (!idMatch) {
        finish(new Error(`Failed to parse Jules session ID from CLI output: ${stdout.trim() || '(empty)'}`));
        return;
      }

      finish(null, {
        sessionId: idMatch[1],
        status: 'QUEUED',
        prompt: prompt.trim(),
        repo: options.repo || 'current',
        output: stdout.trim()
      });
    });

    // Write prompt to stdin and close stream
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      finish(new Error(`Failed writing prompt to jules CLI stdin: ${err.message}`));
    }
  });
}

/**
 * Lists active and completed Jules sessions
 * @param {object} options { dryRun?: boolean, timeoutMs?: number }
 * @returns {Promise<Array<{ id: string, repo: string, status: string, title: string, timestamp?: string }>>}
 */
async function listSessions(options = {}) {
  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';

  if (isDryRun) {
    return options.mockSessions || [
      { id: 's_mock_1', repo: 'owner/repo', status: 'COMPLETED', title: 'Refactor test suite' }
    ];
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;

  return new Promise((resolve, reject) => {
    let invocation;
    try {
      invocation = resolveCommandInvocation('jules', ['remote', 'list', '--session']);
    } catch (err) {
      reject(err);
      return;
    }

    const child = spawn(invocation.file, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(new Error(`jules remote list --session timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', err => finish(err));

    child.on('close', code => {
      if (code !== 0) {
        finish(new Error(`jules remote list --session failed (code ${code}): ${stderr || stdout}`));
        return;
      }

      const sessions = parseSessionListOutput(stdout);
      finish(null, sessions);
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
    const { stdout } = await execFileAsync('jules', ['remote', 'list', '--repo'], { timeout: 5000 });
    return stdout
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('---') && !s.startsWith('Connected'));
  } catch {
    return [];
  }
}

/**
 * Pulls patch from completed Jules session
 * @param {string} sessionId
 * @param {object} options { apply: boolean, dryRun: boolean, timeoutMs?: number }
 * @returns {Promise<{ sessionId: string, patch: string, applied: boolean }>}
 */
async function pullSession(sessionId, options = {}) {
  const cleanId = validateSessionId(sessionId, 'pull');

  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';
  if (isDryRun) {
    return {
      sessionId: cleanId,
      patch: `diff --git a/test.js b/test.js\n--- a/test.js\n+++ b/test.js\n@@ -1 +1 @@\n-old\n+new\n`,
      applied: options.apply === true
    };
  }

  const args = ['remote', 'pull', '--session', cleanId];
  if (options.apply) {
    args.push('--apply');
  }

  const { stdout } = await execFileAsync('jules', args, {
    timeout: options.timeoutMs ?? 10000
  });

  return {
    sessionId: cleanId,
    patch: stdout,
    applied: options.apply === true
  };
}

/**
 * Teleports workspace to session branch
 * @param {string} sessionId
 * @param {object} options { dryRun: boolean, timeoutMs?: number }
 * @returns {Promise<{ sessionId: string, teleported: boolean }>}
 */
async function teleportSession(sessionId, options = {}) {
  const cleanId = validateSessionId(sessionId, 'teleport');

  const isDryRun = options.dryRun || process.env.JULES_DRY_RUN === 'true';
  if (isDryRun) {
    return { sessionId: cleanId, teleported: true };
  }

  await execFileAsync('jules', ['teleport', cleanId], {
    timeout: options.timeoutMs ?? 15000
  });

  return { sessionId: cleanId, teleported: true };
}

module.exports = {
  checkJulesEnvironment,
  newSession,
  listSessions,
  parseSessionListOutput,
  listRepos,
  pullSession,
  teleportSession,
  validateSessionId,
  SESSION_ID_REGEX
};
