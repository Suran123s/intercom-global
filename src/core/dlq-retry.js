// src/core/dlq-retry.js - Dead-Letter Auto-Retry Background Daemon
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getMeshDir } = require('../config');
const {
  retryNtfsOperation,
  withLock,
  validateAgentName,
  resolveSafePath,
  atomicWriteFile,
  atomicWriteFileSync
} = require('./mesh');

const TRANSIENT_PATTERNS = [
  /EBUSY/i,
  /EPERM/i,
  /EACCES/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /503_OVERLOAD/i,
  /RATE_LIMITED/i,
  /429/i,
  /LockTimeoutError/i,
  /lock acquisition timed out/i,
  /target offline/i,
  /target unreachable/i,
  /agent busy/i,
  /handoff confirmation timeout/i
];

const FATAL_PATTERNS = [
  /INVALID_SCHEMA/i,
  /SECURITY_VIOLATION/i,
  /MALFORMED_JSON/i,
  /SecurityError/i,
  /path traversal/i,
  /reserved Windows DOS/i,
  /directory jail violation/i,
  /invalid input/i
];

function isTransientError(errorStr = '') {
  const s = String(errorStr);
  for (const fatal of FATAL_PATTERNS) {
    if (fatal.test(s)) return false;
  }
  for (const trans of TRANSIENT_PATTERNS) {
    if (trans.test(s)) return true;
  }
  return false;
}

function isTransientFailure(reason = '') {
  return isTransientError(reason);
}

function computeBackoffDelay(retryCount = 0, baseDelayMs = 50, maxDelayMs = 2000) {
  const count = Number.isFinite(retryCount) ? Math.max(0, retryCount) : 0;
  const exp = Math.min(count, 8);
  const raw = baseDelayMs * Math.pow(2, exp);
  const jitter = Math.floor(Math.random() * 15);
  return Math.min(raw + jitter, maxDelayMs);
}

class DlqRetryDaemon {
  constructor(meshDir = getMeshDir(), options = {}) {
    this.meshDir = meshDir || getMeshDir();
    this.dlqDir = path.join(this.meshDir, 'dlq');
    this.poisonDir = path.join(this.meshDir, 'dlq', 'poison');
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
    this.baseDelayMs = options.baseDelayMs !== undefined ? options.baseDelayMs : 50;
    this.maxDelayMs = options.maxDelayMs !== undefined ? options.maxDelayMs : 2000;
    this.timer = null;
    this.running = false;
    this.isProcessing = false;

    if (!fs.existsSync(this.dlqDir)) {
      try { fs.mkdirSync(this.dlqDir, { recursive: true }); } catch {}
    }
    if (!fs.existsSync(this.poisonDir)) {
      try { fs.mkdirSync(this.poisonDir, { recursive: true }); } catch {}
    }

    this.stats = {
      scanned: 0,
      retried: 0,
      poisoned: 0,
      skippedPending: 0
    };
  }

  isTransientError(errorStr) {
    return isTransientError(errorStr);
  }

  isTransientFailure(errorStr) {
    return isTransientError(errorStr);
  }

  calculateBackoff(retryCount) {
    return computeBackoffDelay(retryCount, this.baseDelayMs, this.maxDelayMs);
  }

  enqueueDeadLetter(record = {}) {
    const rawId = record.id !== undefined && record.id !== null
      ? String(record.id)
      : `dlq_${crypto.randomUUID().slice(0, 8)}`;
    const id = validateAgentName(rawId);
    const filePath = resolveSafePath(this.dlqDir, `${id}.json`);

    if (!fs.existsSync(this.dlqDir)) {
      fs.mkdirSync(this.dlqDir, { recursive: true });
    }

    const dlqItem = {
      ...record,
      id,
      retryCount: record.retryCount || 0,
      lastError: record.lastError || record.failureReason || 'UNKNOWN_ERROR',
      isTransient: this.isTransientError(record.lastError || record.failureReason),
      nextRetryAt: record.nextRetryAt || Date.now(),
      enqueuedAt: record.enqueuedAt || new Date().toISOString()
    };

    atomicWriteFileSync(filePath, JSON.stringify(dlqItem, null, 2));
    return dlqItem;
  }

  async processDlqOnce(deliveryFn = null) {
    if (this.isProcessing) return;
    if (!fs.existsSync(this.dlqDir)) return;

    this.isProcessing = true;
    try {
      await withLock('dlq_storage', async () => {
        if (!fs.existsSync(this.dlqDir)) return;
        const files = (await fs.promises.readdir(this.dlqDir)).filter(
          (f) => f.endsWith('.json') && !f.startsWith('.')
        );
        this.stats.scanned += files.length;
        const now = Date.now();

        for (const file of files) {
          const filePath = resolveSafePath(this.dlqDir, file);
          let item;
          try {
            item = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
          } catch {
            continue;
          }

          // Re-evaluate transient status cleanly
          const transient = item.isTransient !== undefined
            ? (Boolean(item.isTransient) && this.isTransientError(item.lastError))
            : this.isTransientError(item.lastError);

          // 1. Permanent / Fatal Error -> move to poison immediately
          if (!transient) {
            try {
              const poisonPath = resolveSafePath(this.poisonDir, file);
              await retryNtfsOperation(() => fs.promises.rename(filePath, poisonPath));
            } catch {}
            this.stats.poisoned++;
            continue;
          }

          // 2. Not yet ready for retry
          if (item.nextRetryAt && item.nextRetryAt > now) {
            this.stats.skippedPending++;
            continue;
          }

          // 3. Exceeded max retries -> move to poison
          if ((item.retryCount || 0) >= this.maxRetries) {
            try {
              const poisonPath = resolveSafePath(this.poisonDir, file);
              await retryNtfsOperation(() => fs.promises.rename(filePath, poisonPath));
            } catch {}
            this.stats.poisoned++;
            continue;
          }

          // 4. Attempt retry
          try {
            if (deliveryFn) {
              await deliveryFn(item.recipient || item.to, item.payload || item);
            } else {
              const { writeMessage } = require('./mesh');
              await writeMessage(item.recipient || item.to, {
                sender: item.sender || 'dlq_retry_daemon',
                type: item.type || 'task_dispatch',
                priority: item.priority || 'HIGH',
                payload: item.payload || item
              }, { meshDir: this.meshDir });
            }
            // Success: remove from DLQ
            try {
              await retryNtfsOperation(() => fs.promises.unlink(filePath));
            } catch {}
            this.stats.retried++;
          } catch (err) {
            const errMsg = (err && err.message) ? err.message : String(err);
            item.retryCount = (item.retryCount || 0) + 1;
            item.lastError = errMsg;
            item.isTransient = this.isTransientError(errMsg);

            if (!item.isTransient) {
              // Fatal error on retry (e.g. SecurityError): poison-pill immediately
              try {
                const poisonPath = resolveSafePath(this.poisonDir, file);
                await atomicWriteFile(filePath, JSON.stringify(item, null, 2));
                await retryNtfsOperation(() => fs.promises.rename(filePath, poisonPath));
              } catch {}
              this.stats.poisoned++;
            } else {
              const delay = this.calculateBackoff(item.retryCount);
              item.nextRetryAt = Date.now() + delay;
              try {
                await atomicWriteFile(filePath, JSON.stringify(item, null, 2));
              } catch {}
            }
          }
        }
      }, { ttlMs: 10000, timeoutMs: 10000, meshDir: this.meshDir });
    } finally {
      this.isProcessing = false;
    }
  }

  start(intervalMs = 5000) {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(async () => {
      if (this.isProcessing) return;
      try {
        await this.processDlqOnce();
      } catch {}
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

async function processDlqRetries(options = {}) {
  const daemon = new DlqRetryDaemon(options.meshDir || getMeshDir(), options);
  await daemon.processDlqOnce(options.deliveryFn);
  return daemon.stats;
}

module.exports = {
  DlqRetryDaemon,
  isTransientError,
  isTransientFailure,
  computeBackoffDelay,
  processDlqRetries
};
