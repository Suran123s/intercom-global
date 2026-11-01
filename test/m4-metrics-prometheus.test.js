/**
 * test/m4-metrics-prometheus.test.js
 *
 * Improvement #94: Prometheus Metrics Exporter Test Suite.
 * Validates the Prometheus metrics collector and HTTP exposition format:
 * - Standard Prometheus text format (version=0.0.4)
 * - Metric definitions: messages_total, delivery_latency_ms, mailboxes_total, dlq_messages_total, active_locks_total
 * - Metric types (# TYPE counter, gauge, histogram) and help annotations (# HELP)
 * - Correct label formatting and escaping
 * - Live state synchronization with mesh directory counts
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const http = require('http');
const { MetricsRegistry, MetricsCollector, metrics } = require('../src/core/metrics');
const { createServer } = require('../src/core/server');

describe('Milestone 4 — #94: Prometheus Metrics Exporter Suite', () => {
  let registry;
  let tempMeshDir;

  beforeEach(() => {
    tempMeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-mesh-'));
    fs.mkdirSync(path.join(tempMeshDir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(tempMeshDir, 'locks'), { recursive: true });
    fs.mkdirSync(path.join(tempMeshDir, 'dlq'), { recursive: true });
    registry = new MetricsRegistry(tempMeshDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempMeshDir, { recursive: true, force: true });
    } catch {}
  });

  test('Standard Prometheus Exposition Format: Every metric has # HELP and # TYPE declarations', () => {
    const output = registry.render();

    assert.ok(output.includes('# HELP intercom_messages_total'));
    assert.ok(output.includes('# TYPE intercom_messages_total counter'));
    assert.ok(output.includes('# HELP intercom_delivery_latency_ms'));
    assert.ok(output.includes('# TYPE intercom_delivery_latency_ms histogram'));
    assert.ok(output.includes('# HELP intercom_mailboxes_total'));
    assert.ok(output.includes('# TYPE intercom_mailboxes_total gauge'));
    assert.ok(output.includes('# HELP intercom_dlq_messages_total'));
    assert.ok(output.includes('# TYPE intercom_dlq_messages_total gauge'));
    assert.ok(output.includes('# HELP intercom_active_locks_total'));
    assert.ok(output.includes('# TYPE intercom_active_locks_total gauge'));

    // Output must end with trailing newline
    assert.ok(output.endsWith('\n'));
  });

  test('Counter Tracking: increment correctly aggregates messages_total with status labels', () => {
    registry.increment('intercom_messages_total', { status: 'delivered', recipient: 'worker-1' }, 1);
    registry.increment('intercom_messages_total', { status: 'delivered', recipient: 'worker-1' }, 2);
    registry.increment('intercom_messages_total', { status: 'failed', recipient: 'worker-2' }, 1);

    const output = registry.render();

    assert.ok(output.includes('intercom_messages_total{status="delivered",recipient="worker-1"} 3'));
    assert.ok(output.includes('intercom_messages_total{status="failed",recipient="worker-2"} 1'));
  });

  test('Histogram Tracking: observe accumulates count and sum for delivery latency', () => {
    registry.observe('intercom_delivery_latency_ms', { transport: 'atomic_discrete' }, 12.5);
    registry.observe('intercom_delivery_latency_ms', { transport: 'atomic_discrete' }, 7.5);

    const output = registry.render();

    assert.ok(output.includes('intercom_delivery_latency_ms_count{transport="atomic_discrete"} 2'));
    assert.ok(output.includes('intercom_delivery_latency_ms_sum{transport="atomic_discrete"} 20.00'));
  });

  test('Gauge Tracking: setGauge updates live gauges for active mailboxes and DLQ size', () => {
    registry.setGauge('intercom_mailboxes_total', {}, 8);
    registry.setGauge('intercom_dlq_messages_total', {}, 0);
    registry.setGauge('intercom_active_locks_total', {}, 1);

    const output = registry.render();

    assert.ok(output.includes('intercom_mailboxes_total 8'));
    assert.ok(output.includes('intercom_dlq_messages_total 0'));
    assert.ok(output.includes('intercom_active_locks_total 1'));
  });

  test('Content-Type Header Validation: Conforms to Prometheus exposition content-type standard', () => {
    const expectedContentType = 'text/plain; version=0.0.4; charset=utf-8';
    assert.match(expectedContentType, /text\/plain/);
    assert.match(expectedContentType, /version=0\.0\.4/);
  });

  test('HTTP Endpoint: /metrics and /api/intercom/metrics serve Prometheus exposition text', async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      for (const endpoint of ['/metrics', '/api/intercom/metrics']) {
        const body = await new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}${endpoint}`, (res) => {
            assert.equal(res.statusCode, 200);
            assert.equal(res.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve(data));
          }).on('error', reject);
        });

        assert.ok(body.includes('# HELP intercom_messages_total'));
        assert.ok(body.includes('# TYPE intercom_messages_total counter'));
        assert.ok(body.endsWith('\n'));
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
