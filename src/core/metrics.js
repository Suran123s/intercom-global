/**
 * src/core/metrics.js
 *
 * Improvement #94: Prometheus Metrics Collector & Exposition Engine.
 * Provides a zero-dependency Prometheus metrics collector and exposition formatter
 * conforming to Prometheus Text Format 0.0.4 (RFC 0004):
 * - Counter metrics (messages_total, compaction_runs_total)
 * - Histogram metrics (delivery_latency_ms)
 * - Gauge metrics (mailboxes_total, dlq_messages_total, active_locks_total, process memory)
 * - Live mesh directory gauge synchronizer
 * - Standalone HTTP exporter and router integration
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { getMeshDir } = require('../config');

const MAX_RECIPIENT_CARDINALITY = 200;
const MAX_DLQ_REASON_CARDINALITY = 50;

function normalizeDlqReason(reason) {
  if (!reason) return 'UNKNOWN';
  let fallbackName = '';
  if (typeof reason === 'object') {
    if (reason.code && typeof reason.code === 'string') {
      return reason.code.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32) || 'UNKNOWN';
    }
    if (reason.name && typeof reason.name === 'string' && reason.name !== 'Error') {
      fallbackName = reason.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32);
    }
    if (reason.message) {
      reason = reason.message;
    } else if (fallbackName) {
      return fallbackName;
    }
  }
  const str = String(reason).trim();
  if (!str) return fallbackName || 'UNKNOWN';
  // Extract leading error code if present (e.g. "ENOENT: ...", "SecurityError: ...")
  const codeMatch = str.match(/^([A-Za-z][A-Za-z0-9_]{1,31})(?:\s*:|$)/);
  if (codeMatch) {
    return codeMatch[1].toUpperCase();
  }
  if (/timeout|timed out/i.test(str)) return 'TIMEOUT';
  if (/enoent|not found/i.test(str)) return 'ENOENT';
  if (/eperm|ebusy|eacces|lock/i.test(str)) return 'LOCK_OR_ACCESS_ERROR';
  if (/security|traversal|invalid/i.test(str)) return 'VALIDATION_ERROR';
  if (/json|parse/i.test(str)) return 'PARSE_ERROR';
  return fallbackName || str.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'UNKNOWN';
}

class MetricsRegistry {
  constructor(baseMeshDir = null) {
    this._explicitBaseMeshDir = baseMeshDir || null;
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this._knownRecipients = new Set();
    this._knownDlqReasons = new Set();

    // Default compaction metrics counters
    this.compactionRuns = 0;
    this.compactionPrunedDirs = 0;
    this.compactionReclaimedBytes = 0;
  }

  get baseMeshDir() {
    return this._explicitBaseMeshDir || getMeshDir();
  }

  set baseMeshDir(val) {
    this._explicitBaseMeshDir = val || null;
  }

  /**
   * Increments a counter metric.
   * @param {string} name
   * @param {object} [labels={}]
   * @param {number} [value=1]
   */
  increment(name, labels = {}, value = 1) {
    const key = `${name}:${JSON.stringify(labels)}`;
    const current = this.counters.get(key) || { name, labels, value: 0 };
    current.value += value;
    this.counters.set(key, current);
  }

  /**
   * Sets a gauge metric.
   * @param {string} name
   * @param {object} [labels={}]
   * @param {number} [value=0]
   */
  setGauge(name, labels = {}, value = 0) {
    const key = `${name}:${JSON.stringify(labels)}`;
    this.gauges.set(key, { name, labels, value });
  }

  /**
   * Records an observation in a histogram metric.
   * @param {string} name
   * @param {object} [labels={}]
   * @param {number} [value=0]
   */
  observe(name, labels = {}, value = 0) {
    const key = `${name}:${JSON.stringify(labels)}`;
    const current = this.histograms.get(key) || { name, labels, count: 0, sum: 0 };
    current.count++;
    current.sum += value;
    this.histograms.set(key, current);
  }

  /**
   * Formats a label dictionary into Prometheus label syntax: {k="v",...}
   * Escapes backslash, double-quote, CR, and LF per Prometheus Text Format 0.0.4.
   * @param {object} [labels={}]
   * @returns {string}
   */
  formatLabels(labels = {}) {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const formatted = entries
      .map(([k, v]) => {
        const escaped = String(v)
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\r/g, '\\r')
          .replace(/\n/g, '\\n');
        return `${k}="${escaped}"`;
      })
      .join(',');
    return `{${formatted}}`;
  }

  _boundRecipientLabel(recipient = 'unknown') {
    const clean = String(recipient || 'unknown').slice(0, 64);
    if (this._knownRecipients.has(clean)) return clean;
    if (this._knownRecipients.size < MAX_RECIPIENT_CARDINALITY) {
      this._knownRecipients.add(clean);
      return clean;
    }
    return '_other';
  }

  _boundDlqReasonLabel(reason = 'UNKNOWN') {
    const code = normalizeDlqReason(reason);
    if (this._knownDlqReasons.has(code)) return code;
    if (this._knownDlqReasons.size < MAX_DLQ_REASON_CARDINALITY) {
      this._knownDlqReasons.add(code);
      return code;
    }
    return 'OTHER';
  }

  /**
   * Records a sent message event.
   */
  recordMessageSent(type = 'task_dispatch', priority = 'NORMAL', recipient = 'unknown') {
    this.increment('intercom_messages_total', {
      status: 'sent',
      type: String(type || 'task_dispatch').slice(0, 48),
      priority: String(priority || 'NORMAL').toUpperCase().slice(0, 16)
    });
  }

  /**
   * Records a delivered message event and its latency with bounded label cardinality.
   */
  recordMessageDelivered(type = 'task_dispatch', recipient = 'unknown', status = 'delivered', latencyMs = 0) {
    const boundedRecipient = this._boundRecipientLabel(recipient);
    this.increment('intercom_messages_total', {
      status: String(status || 'delivered').slice(0, 32),
      recipient: boundedRecipient,
      type: String(type || 'task_dispatch').slice(0, 48)
    });
    if (latencyMs > 0) {
      this.observe('intercom_delivery_latency_ms', { transport: 'atomic_discrete' }, latencyMs);
    }
  }

  /**
   * Records an in-memory fast-queue delivery event.
   */
  recordFastQueueDelivery(mode = 'fast-path-memory') {
    this.increment('intercom_fast_queue_delivered_total', { mode });
  }

  /**
   * Records a dead-letter queue enqueue event with normalized bounded error code label.
   */
  recordDlqEnqueue(reason = 'UNKNOWN') {
    const boundedReason = this._boundDlqReasonLabel(reason);
    this.increment('intercom_dlq_enqueued_total', { reason: boundedReason });
  }

  /**
   * Records a compaction execution.
   */
  recordCompactionRun(prunedDirs = 0, reclaimedBytes = 0) {
    this.compactionRuns++;
    this.compactionPrunedDirs += prunedDirs;
    this.compactionReclaimedBytes += reclaimedBytes;
  }

  /**
   * Scans filesystem for active mailboxes, DLQ messages, and held CAS locks.
   * Skips per-mailbox message file scans unless options.includeMailboxCounts is true.
   */
  gatherFilesystemGauges(meshDir = this.baseMeshDir, options = {}) {
    const includeMailboxCounts = options && options.includeMailboxCounts === true;
    let activeMailboxes = 0;
    const mailboxCounts = new Map();
    let dlqCount = 0;
    let dlqPoisonCount = 0;
    let activeLocks = 0;

    const inboxBase = path.join(meshDir, 'inbox');
    if (fs.existsSync(inboxBase)) {
      try {
        const dirs = fs.readdirSync(inboxBase, { withFileTypes: true });
        for (const d of dirs) {
          if (d.isDirectory()) {
            activeMailboxes++;
            if (includeMailboxCounts) {
              const fullDir = path.join(inboxBase, d.name);
              try {
                const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.json') && !f.startsWith('.tmp'));
                mailboxCounts.set(d.name, files.length);
              } catch {}
            }
          }
        }
      } catch {}
    }

    const dlqBase = path.join(meshDir, 'dlq');
    if (fs.existsSync(dlqBase)) {
      try {
        const dlqFiles = fs.readdirSync(dlqBase).filter(f => f.endsWith('.json'));
        dlqCount = dlqFiles.length;
      } catch {}

      const poisonBase = path.join(dlqBase, 'poison');
      if (fs.existsSync(poisonBase)) {
        try {
          dlqPoisonCount = fs.readdirSync(poisonBase).filter(f => f.endsWith('.json')).length;
        } catch {}
      }
    }

    const locksBase = path.join(meshDir, 'locks');
    if (fs.existsSync(locksBase)) {
      try {
        activeLocks = fs.readdirSync(locksBase).filter(f => f.endsWith('.lock')).length;
      } catch {}
    }

    return {
      activeMailboxes,
      mailboxCounts,
      dlqCount,
      dlqPoisonCount,
      activeLocks
    };
  }

  /**
   * Syncs live gauges with disk state dynamically on every scrape/render call.
   */
  syncLiveGauges(meshDir = this.baseMeshDir, options = {}) {
    const fsGauges = this.gatherFilesystemGauges(meshDir, options);

    this.setGauge('intercom_mailboxes_total', {}, fsGauges.activeMailboxes);
    this.setGauge('intercom_dlq_messages_total', {}, fsGauges.dlqCount);
    this.setGauge('intercom_active_locks_total', {}, fsGauges.activeLocks);

    return fsGauges;
  }

  /**
   * Renders the complete Prometheus exposition output.
   * @param {object} [options={}]
   * @returns {string}
   */
  render(options = {}) {
    this.syncLiveGauges(this.baseMeshDir, options);

    const lines = [];

    // 1. intercom_messages_total
    lines.push('# HELP intercom_messages_total Total count of messages dispatched across mesh');
    lines.push('# TYPE intercom_messages_total counter');
    const msgCounters = Array.from(this.counters.values()).filter((c) => c.name === 'intercom_messages_total');
    if (msgCounters.length === 0) {
      lines.push('intercom_messages_total{status="delivered"} 0');
    } else {
      for (const c of msgCounters) {
        lines.push(`intercom_messages_total${this.formatLabels(c.labels)} ${c.value}`);
      }
    }

    // 2. intercom_delivery_latency_ms
    lines.push('# HELP intercom_delivery_latency_ms Message delivery latency in milliseconds');
    lines.push('# TYPE intercom_delivery_latency_ms histogram');
    const latencies = Array.from(this.histograms.values()).filter((h) => h.name === 'intercom_delivery_latency_ms');
    if (latencies.length === 0) {
      lines.push('intercom_delivery_latency_ms_count 0');
      lines.push('intercom_delivery_latency_ms_sum 0');
    } else {
      for (const h of latencies) {
        const lbl = this.formatLabels(h.labels);
        lines.push(`intercom_delivery_latency_ms_count${lbl} ${h.count}`);
        lines.push(`intercom_delivery_latency_ms_sum${lbl} ${h.sum.toFixed(2)}`);
      }
    }

    // 3. intercom_mailboxes_total
    lines.push('# HELP intercom_mailboxes_total Total active mailboxes currently in mesh');
    lines.push('# TYPE intercom_mailboxes_total gauge');
    const mboxGauges = Array.from(this.gauges.values()).filter((g) => g.name === 'intercom_mailboxes_total');
    if (mboxGauges.length === 0) {
      lines.push('intercom_mailboxes_total 0');
    } else {
      for (const g of mboxGauges) {
        lines.push(`intercom_mailboxes_total${this.formatLabels(g.labels)} ${g.value}`);
      }
    }

    // 4. intercom_dlq_messages_total
    lines.push('# HELP intercom_dlq_messages_total Total count of dead-letter messages in DLQ');
    lines.push('# TYPE intercom_dlq_messages_total gauge');
    const dlqGauges = Array.from(this.gauges.values()).filter((g) => g.name === 'intercom_dlq_messages_total');
    if (dlqGauges.length === 0) {
      lines.push('intercom_dlq_messages_total 0');
    } else {
      for (const g of dlqGauges) {
        lines.push(`intercom_dlq_messages_total${this.formatLabels(g.labels)} ${g.value}`);
      }
    }

    // 5. intercom_active_locks_total
    lines.push('# HELP intercom_active_locks_total Current number of held NTFS CAS locks');
    lines.push('# TYPE intercom_active_locks_total gauge');
    const lockGauges = Array.from(this.gauges.values()).filter((g) => g.name === 'intercom_active_locks_total');
    if (lockGauges.length === 0) {
      lines.push('intercom_active_locks_total 0');
    } else {
      for (const g of lockGauges) {
        lines.push(`intercom_active_locks_total${this.formatLabels(g.labels)} ${g.value}`);
      }
    }

    // 6. Compaction metrics (if any compaction occurred)
    if (this.compactionRuns > 0) {
      lines.push('# HELP intercom_compaction_runs_total Total number of compaction executions');
      lines.push('# TYPE intercom_compaction_runs_total counter');
      lines.push(`intercom_compaction_runs_total ${this.compactionRuns}`);

      lines.push('# HELP intercom_compaction_pruned_dirs_total Total empty directories pruned');
      lines.push('# TYPE intercom_compaction_pruned_dirs_total counter');
      lines.push(`intercom_compaction_pruned_dirs_total ${this.compactionPrunedDirs}`);
    }

    // 6b. FastQueue & DLQ enqueue counters (when recorded)
    const fastCounters = Array.from(this.counters.values()).filter((c) => c.name === 'intercom_fast_queue_delivered_total');
    if (fastCounters.length > 0) {
      lines.push('# HELP intercom_fast_queue_delivered_total Total in-memory fast-queue deliveries');
      lines.push('# TYPE intercom_fast_queue_delivered_total counter');
      for (const c of fastCounters) {
        lines.push(`intercom_fast_queue_delivered_total${this.formatLabels(c.labels)} ${c.value}`);
      }
    }

    const dlqEnqueueCounters = Array.from(this.counters.values()).filter((c) => c.name === 'intercom_dlq_enqueued_total');
    if (dlqEnqueueCounters.length > 0) {
      lines.push('# HELP intercom_dlq_enqueued_total Total messages enqueued to dead-letter queue');
      lines.push('# TYPE intercom_dlq_enqueued_total counter');
      for (const c of dlqEnqueueCounters) {
        lines.push(`intercom_dlq_enqueued_total${this.formatLabels(c.labels)} ${c.value}`);
      }
    }

    // 7. Process metrics
    const mem = process.memoryUsage();
    lines.push('# HELP process_uptime_seconds Total process uptime in seconds');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${Math.floor(process.uptime())}`);

    lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes');
    lines.push('# TYPE process_resident_memory_bytes gauge');
    lines.push(`process_resident_memory_bytes ${mem.rss}`);

    lines.push('# HELP process_heap_used_bytes Process heap memory used in bytes');
    lines.push('# TYPE process_heap_used_bytes gauge');
    lines.push(`process_heap_used_bytes ${mem.heapUsed}`);

    lines.push(''); // Final trailing newline
    return lines.join('\n');
  }

  /**
   * Alias for render() conforming to Prometheus exposition format.
   * @returns {string}
   */
  formatPrometheus() {
    return this.render();
  }
}

class MetricsCollector extends MetricsRegistry {}

// Singleton default instance
const metrics = new MetricsRegistry();

/**
 * Starts a standalone Prometheus HTTP exposition server bound to loopback 127.0.0.1.
 * @param {number} [port=9102]
 * @param {string} [host='127.0.0.1']
 * @returns {http.Server}
 */
function startMetricsServer(port = 9102, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    if (req.url === '/metrics' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.formatPrometheus());
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  server.on('error', (err) => {
    console.error('[Metrics Server Error]:', err.message);
  });
  server.listen(port, host);
  return server;
}

module.exports = {
  MetricsRegistry,
  MetricsCollector,
  metrics,
  startMetricsServer
};
