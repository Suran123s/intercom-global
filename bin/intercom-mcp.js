#!/usr/bin/env node
// bin/intercom-mcp.js - MCP Server Executable Binary
const { startMcpServer } = require('../src/mcp/server');
const { scheduleBackgroundSync } = require('../src/live-scraper');

// Start MCP server first (installs stdout -> stderr guard) and trigger
// non-blocking background scrape in a stdio-isolated worker.
startMcpServer();
try {
  scheduleBackgroundSync({ mode: 'subprocess' });
} catch {}
