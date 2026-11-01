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
const { MESH_DIR } = require('../config');

class MetricsRegistry {
  constructor(baseMeshDir = MESH_DIR) {
    this.baseMeshDir = baseMeshDir;
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();

    // Default compaction metrics counters
    this.compactionRuns = 0;
    this.compactionPrunedDirs = 0;
    this.compactionReclaimedBytes = 0;
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
   * @param {object} [labels={}]
   * @returns {string}
   */
  formatLabels(labels = {}) {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const formatted = entries
      .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',');
    return `{${formatted}}`;
  }

  /**
   * Records a sent message event.
   */
  recordMessageSent(type = 'task_dispatch', priority = 'NORMAL', recipient = 'unknown') {
    this.increment('intercom_messages_total', { status: 'sent', type, priority });
  }

  /**
   * Records a delivered message event and its latency.
   */
  recordMessageDelivered(type = 'task_dispatch', recipient = 'unknown', status = 'delivered', latencyMs = 0) {
    this.increment('intercom_messages_total', { status, recipient, type });
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
   * Records a dead-letter queue enqueue event.
   */
  recordDlqEnqueue(reason = 'UNKNOWN') {
    this.increment('intercom_dlq_enqueued_total', { reason });
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
   */
  gatherFilesystemGauges(meshDir = this.baseMeshDir) {
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
            const fullDir = path.join(inboxBase, d.name);
            try {
              const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.json') && !f.startsWith('.tmp'));
              mailboxCounts.set(d.name, files.length);
            } catch {}
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
   * Syncs live gauges with disk state if no manual values were set.
   */
  syncLiveGauges(meshDir = this.baseMeshDir) {
    const fsGauges = this.gatherFilesystemGauges(meshDir);

    const hasMbox = Array.from(this.gauges.values()).some(g => g.name === 'intercom_mailboxes_total');
    if (!hasMbox) {
      this.setGauge('intercom_mailboxes_total', {}, fsGauges.activeMailboxes);
    }

    const hasDlq = Array.from(this.gauges.values()).some(g => g.name === 'intercom_dlq_messages_total');
    if (!hasDlq) {
      this.setGauge('intercom_dlq_messages_total', {}, fsGauges.dlqCount);
    }

    const hasLocks = Array.from(this.gauges.values()).some(g => g.name === 'intercom_active_locks_total');
    if (!hasLocks) {
      this.setGauge('intercom_active_locks_total', {}, fsGauges.activeLocks);
    }

    return fsGauges;
  }

  /**
   * Renders the complete Prometheus exposition output.
   * @returns {string}
   */
  render() {
    this.syncLiveGauges();

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
 * Starts a standalone Prometheus HTTP exposition server.
 * @param {number} [port=9102]
 * @returns {http.Server}
 */
function startMetricsServer(port = 9102) {
  const server = http.createServer((req, res) => {
    if (req.url === '/metrics' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.formatPrometheus());
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  server.listen(port);
  return server;
}

module.exports = {
  MetricsRegistry,
  MetricsCollector,
  metrics,
  startMetricsServer
};
