#!/usr/bin/env node
// bin/intercom.js - Main CLI Executable
const { run } = require('../src/cli');
const { scheduleBackgroundSync } = require('../src/live-scraper');

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

const SKIP_SYNC_COMMANDS = new Set([
  '__daemon_run',
  'mcp',
  'sync',
  'help',
  'tui',
  'metrics',
  'read',
  'check',
  'peers',
  'doctor',
  'watch',
  'governance'
]);

const isReadOnlySubcommand = (
  (command === 'dlq' && (!subcommand || subcommand === 'list' || subcommand === 'show')) ||
  (command === 'channel' && (!subcommand || subcommand === 'list' || subcommand === 'read')) ||
  (command === 'handoff' && subcommand === 'status') ||
  (command === 'daemon' && (!subcommand || subcommand === 'status')) ||
  (command === 'jules' && (!subcommand || subcommand === 'check' || subcommand === 'list' || subcommand === 'status'))
);

const hasHelpFlag = args.includes('--help') || args.includes('-h');

if (command && !command.startsWith('-') && !hasHelpFlag && !SKIP_SYNC_COMMANDS.has(command) && !isReadOnlySubcommand) {
  try {
    scheduleBackgroundSync({ mode: 'subprocess' });
  } catch {}
}

run();
