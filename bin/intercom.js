#!/usr/bin/env node
// bin/intercom.js - Main CLI Executable
const { run } = require('../src/cli');
const { scheduleBackgroundSync } = require('../src/live-scraper');

const command = process.argv[2];
if (command && command !== '__daemon_run' && command !== 'mcp' && command !== 'sync') {
  try {
    scheduleBackgroundSync({ mode: 'subprocess' });
  } catch {}
}

run();
