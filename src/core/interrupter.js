// src/core/interrupter.js - 3-Tier Real-Time Agent Interruption Engine
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { getMeshDir, getPort } = require('../config');
const { MessageEnvelope } = require('./message');
const { writeMessage, validateAgentName, retryNtfsOperation, atomicWriteFile } = require('./mesh');

/**
 * Strips ANSI escape sequences and ASCII control characters from PTY steering text.
 * @param {string} text
 * @returns {string}
 */
function sanitizePtyText(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim();
}

class Interrupter {
  constructor(options = {}) {
    this._explicitPort = options.port !== undefined ? options.port : undefined;
    this._explicitDaemonUrl = options.daemonUrl || undefined;
    this._explicitMeshDir = options.meshDir || undefined;
  }

  get port() {
    return this._explicitPort !== undefined ? this._explicitPort : getPort();
  }

  get daemonUrl() {
    return this._explicitDaemonUrl || `http://127.0.0.1:${this.port}`;
  }

  get interruptsDir() {
    return path.join(this._explicitMeshDir || getMeshDir(), 'interrupts');
  }

  /**
   * 3-tier agent interruption
   * @param {string} target Target agent identifier
   * @param {string} reason Interruption reason / steering instructions
   * @param {object} options { mode: 'auto'|'pty'|'jsonrpc'|'mesh', childProcess, stream, requestId }
   * @returns {Promise<{ interrupted: boolean, method: string, details: object }>}
   */
  async interruptAgent(target, reason, options = {}) {
    const cleanTarget = validateAgentName(target);
    const mode = options.mode || 'auto';
    const timestamp = new Date().toISOString();
    const details = { target: cleanTarget, reason, timestamp, tiersExecuted: [] };

    // --- Tier 1: PTY / Terminal Mode (Stdin Preemption) ---
    if (mode === 'pty' || (mode === 'auto' && options.childProcess && options.childProcess.stdin && !options.isJsonRpc)) {
      try {
        const child = options.childProcess;
        if (child && child.stdin && !child.stdin.destroyed) {
          // ASCII 0x03 (Ctrl+C / End-of-Text)
          child.stdin.write('\x03');
          // Steering payload (sanitized against control/escape sequence injection)
          const safeReason = sanitizePtyText(reason);
          child.stdin.write(`\n[INTERRUPT]: User commanded pivot: ${safeReason}\n`);
          details.tiersExecuted.push('pty_stdin_preemption');
        }
      } catch (e) {
        details.ptyError = e.message;
      }
    }

    // --- Tier 2: Headless Stdio / JSON-RPC Mode ---
    // CRITICAL INVARIANT: Strictly NO raw \x03 on JSON-RPC pipes!
    if (mode === 'jsonrpc' || (mode === 'auto' && (options.isJsonRpc || options.stream))) {
      try {
        if (options.stream && !options.stream.destroyed) {
          const cancelEnvelope = {
            jsonrpc: "2.0",
            method: "$/cancelRequest",
            params: { id: options.requestId || "active" }
          };
          options.stream.write(JSON.stringify(cancelEnvelope) + '\n');
          details.tiersExecuted.push('jsonrpc_in_band_cancellation');
        }
      } catch (e) {
        details.jsonRpcError = e.message;
      }
    }

    // Out-of-band HTTP Daemon Interruption
    let httpSuccess = false;
    if (!options.skipHttp && (mode === 'auto' || mode === 'jsonrpc')) {
      httpSuccess = await this.sendHttpInterrupt(cleanTarget, reason, options);
      if (httpSuccess) {
        details.tiersExecuted.push('out_of_band_http_daemon');
        // The daemon delegates to interrupter with { mode: 'mesh', skipHttp: true },
        // which has already written the Safe-Path envelope and flag file to the mesh.
        details.tiersExecuted.push('safe_path_envelope');
      } else {
        details.httpDaemonNotice = 'Daemon offline or unreachable; Safe-Path file-mesh will deliver interrupt';
      }
    }

    // --- Tier 3: Safe-Path File-Mesh Interrupt Flag (Zero-Loss Guarantee) ---
    if (mode === 'mesh' || mode === 'auto') {
      try {
        const meshDir = this._explicitMeshDir || getMeshDir();
        // 1. Write high-priority interrupt envelope to inbox only if not already written by daemon
        if (!httpSuccess) {
          const interruptEnvelope = MessageEnvelope.create({
            sender: options.sender || 'supervisor',
            recipient: cleanTarget,
            type: 'interrupt',
            priority: 'CRITICAL',
            payload: {
              action: 'ABORT_ACTIVE_TASK',
              reason: reason || 'Immediate user redirection requested',
              timestamp
            }
          });

          await writeMessage(cleanTarget, interruptEnvelope, { meshDir });
          details.tiersExecuted.push('safe_path_envelope');
        }

        // 2. Write atomic interrupt flag file (idempotent write ensures flag exists on disk)
        const dir = this.interruptsDir;
        await fs.promises.mkdir(dir, { recursive: true });
        const flagFile = path.join(dir, `${cleanTarget}.flag`);
        const flagContent = JSON.stringify({
          target: cleanTarget,
          reason,
          timestamp,
          active: true
        }, null, 2);

        await atomicWriteFile(flagFile, flagContent);
        if (!details.tiersExecuted.includes('safe_path_flag_file')) {
          details.tiersExecuted.push('safe_path_flag_file');
        }
      } catch (e) {
        details.meshError = e.message;
      }
    }

    const interrupted = details.tiersExecuted.length > 0;
    return {
      interrupted,
      method: details.tiersExecuted.join('+') || 'none',
      details
    };
  }

  /**
   * Sends an out-of-band interrupt via local loopback HTTP daemon
   */
  async sendHttpInterrupt(target, reason, options = {}) {
    return new Promise((resolve) => {
      const payload = JSON.stringify({
        agent: target,
        reason,
        options: { ...options, childProcess: undefined, stream: undefined }
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: '/api/intercom/interrupt',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 1500
      }, (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        });
      });

      req.on('error', () => {
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Checks whether an active interrupt flag exists for the given agent
   */
  hasInterruptFlag(target) {
    const cleanTarget = validateAgentName(target);
    const flagFile = path.join(this.interruptsDir, `${cleanTarget}.flag`);
    return fs.existsSync(flagFile);
  }

  /**
   * Reads and consumes (clears) the interrupt flag for an agent atomically
   */
  async consumeInterruptFlag(target) {
    const cleanTarget = validateAgentName(target);
    const dir = this.interruptsDir;
    const flagFile = path.join(dir, `${cleanTarget}.flag`);
    const claimingFile = path.join(
      dir,
      `.${cleanTarget}.flag.consuming.${process.pid}.${crypto.randomUUID().slice(0, 8)}`
    );

    try {
      await retryNtfsOperation(() => fs.promises.rename(flagFile, claimingFile));
    } catch {
      return null;
    }

    try {
      const content = await retryNtfsOperation(() => fs.promises.readFile(claimingFile, 'utf8'));
      return JSON.parse(content);
    } catch {
      return null;
    } finally {
      try {
        await retryNtfsOperation(() => fs.promises.unlink(claimingFile));
      } catch {}
    }
  }
}

const defaultInterrupter = new Interrupter();

module.exports = {
  Interrupter,
  interruptAgent: (target, reason, options) => defaultInterrupter.interruptAgent(target, reason, options),
  hasInterruptFlag: (target) => defaultInterrupter.hasInterruptFlag(target),
  consumeInterruptFlag: (target) => defaultInterrupter.consumeInterruptFlag(target)
};
