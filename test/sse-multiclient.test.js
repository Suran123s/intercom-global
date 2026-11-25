/**
 * test/sse-multiclient.test.js
 *
 * Improvement #92: Multi-Client Fast-Path Server-Sent Events (SSE) Real-Time Integration Test Suite.
 * Validates real-time Server-Sent Events stream under multiple concurrent listeners:
 * - Multi-client connection and handshake (text/event-stream)
 * - Broadcast fan-out to all active SSE listeners without cross-talk or message loss
 * - Clean client disconnect and set pruning without memory leaks or broadcast crashes
 * - Multi-subscriber in-memory fast queue integration
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createServer, dispatchMessage } = require('../src/core/server');
const { FastQueue, SubscriptionFilter } = require('../src/core/fast-queue');
const { clearInbox } = require('../src/core/mesh');
const { createIsolatedMeshEnv, closeServer, waitForCondition } = require('./helpers/isolated-env');

describe('Milestone 4 — #92: Multi-Client Fast-Path SSE Real-Time Integration', () => {
  let iso;
  let server;
  let serverPort;
  let testAgent;
  const connectedClients = new Set();

  beforeEach(async () => {
    iso = createIsolatedMeshEnv('intercom-sse-');
    testAgent = `sse-test-${Date.now()}`;
    server = createServer();
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const c of connectedClients) {
      try { c.close(); } catch {}
    }
    connectedClients.clear();

    await closeServer(server);
    try { await clearInbox(testAgent); } catch {}
    iso.cleanup();
  });

  /**
   * Helper to create an SSE client connection
   * @param {number} port
   * @returns {Promise<{ req: http.ClientRequest, res: http.IncomingMessage, events: Array<object>, close: Function }>}
   */
  function connectSseClient(port) {
    return new Promise((resolve, reject) => {
      const events = [];
      let buffer = '';

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/intercom/events',
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Connection: 'keep-alive'
          }
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers['content-type'], /text\/event-stream/);

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const parts = buffer.split('\n\n');
            buffer = parts.pop(); // Keep incomplete tail

            for (const part of parts) {
              if (!part.trim()) continue;
              const lines = part.split('\n');
              let eventType = 'message';
              let eventData = null;

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  eventType = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                  try {
                    eventData = JSON.parse(line.slice(6));
                  } catch {
                    eventData = line.slice(6);
                  }
                }
              }

              if (eventData !== null) {
                events.push({ type: eventType, data: eventData });
              }
            }
          });

          const clientHandle = {
            req,
            res,
            events,
            close: () => {
              try { req.destroy(); } catch {}
              try { res.destroy(); } catch {}
            }
          };
          connectedClients.add(clientHandle);
          resolve(clientHandle);
        }
      );

      req.on('error', reject);
      req.end();
    });
  }

  test('Multi-Client SSE Handshake: Multiple clients connect and receive initial handshake event', async () => {
    const clientCount = 4;
    const clients = [];

    for (let i = 0; i < clientCount; i++) {
      clients.push(await connectSseClient(serverPort));
    }

    // Wait for connection event
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(clients.length, clientCount);
    for (const c of clients) {
      assert.ok(c.events.length >= 1, 'Client must receive initial connected event');
      assert.equal(c.events[0].data.type, 'connected');
      c.close();
    }
  });

  test('Broadcast Fan-Out: Dispatched message is received concurrently by all connected SSE listeners', async () => {
    const clientCount = 3;
    const clients = [];

    for (let i = 0; i < clientCount; i++) {
      clients.push(await connectSseClient(serverPort));
    }

    await new Promise((r) => setTimeout(r, 50));

    // Dispatch message through server
    const dispatched = dispatchMessage('coordinator', testAgent, 'Real-time broadcast payload across SSE mesh');
    assert.ok(dispatched && dispatched.id);

    // Wait for broadcast propagation
    await new Promise((r) => setTimeout(r, 150));

    for (let i = 0; i < clientCount; i++) {
      const c = clients[i];
      const msgEvent = c.events.find((e) => {
        const d = e.data;
        const text = d?.payload?.message || d?.message;
        return text === 'Real-time broadcast payload across SSE mesh';
      });
      assert.ok(msgEvent, `Client ${i} must receive the dispatched broadcast message`);
      const recipient = msgEvent.data.payload?.to || msgEvent.data.to;
      const sender = msgEvent.data.payload?.from || msgEvent.data.from;
      assert.equal(recipient, testAgent);
      assert.equal(sender, 'coordinator');
      c.close();
    }
  });

  test('Graceful Disconnection: Dropping client does not crash server or disrupt remaining listeners', async () => {
    const clientA = await connectSseClient(serverPort);
    const clientB = await connectSseClient(serverPort);

    await new Promise((r) => setTimeout(r, 50));

    // Abruptly disconnect client A
    clientA.close();
    await new Promise((r) => setTimeout(r, 50));

    // Dispatch another message to client B
    dispatchMessage('coordinator', testAgent, 'Message after client A disconnect');
    await new Promise((r) => setTimeout(r, 150));

    const msgEvent = clientB.events.find((e) => {
      const d = e.data;
      const text = d?.payload?.message || d?.message;
      return text === 'Message after client A disconnect';
    });
    assert.ok(msgEvent, 'Remaining client B must receive message cleanly');

    clientB.close();
  });

  test('FastQueue In-Memory Multi-Subscriber Fan-Out', async () => {
    const fastQueue = new FastQueue({ maxQueueDepth: 50 });
    const subscriberCount = 3;
    const receivedMessages = [[], [], []];

    fastQueue.registerLocalAgent('target-worker');

    for (let i = 0; i < subscriberCount; i++) {
      fastQueue.subscribe('target-worker', null, (msg) => {
        receivedMessages[i].push(msg);
      });
    }

    await fastQueue.dispatch('target-worker', {
      sender: 'coordinator',
      type: 'task_event',
      payload: { code: 'READY' }
    });

    for (let i = 0; i < subscriberCount; i++) {
      assert.equal(receivedMessages[i].length, 1, `Subscriber ${i} must receive in-memory event`);
      assert.equal(receivedMessages[i][0].payload.code, 'READY');
    }
  });
});
