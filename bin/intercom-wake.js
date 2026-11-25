#!/usr/bin/env node
// bin/intercom-wake.js - Auto-Wake Executable Shortcut
const { wakeAgent } = require('../src/controllers/autowake');

function parseWakeArgs(argv) {
  let flagTo = null;
  let flagMsg = null;
  let help = false;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--to' && i + 1 < argv.length) {
      flagTo = argv[++i];
    } else if (arg.startsWith('--to=')) {
      flagTo = arg.slice('--to='.length);
    } else if (arg === '--msg' && i + 1 < argv.length) {
      flagMsg = argv[++i];
    } else if (arg.startsWith('--msg=')) {
      flagMsg = arg.slice('--msg='.length);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  const to = flagTo || positional[0] || null;
  const msg = flagMsg || (flagTo ? positional[0] : positional[1]) || null;
  return { to, msg, help };
}

function printUsage() {
  console.log(`
⚡ Intercom Auto-Wake Shortcut

Usage:
  intercom-wake <targetName> "<task>"
  intercom-wake --to <targetName> --msg "<task>"

Examples:
  intercom-wake Keshav "Check customer routes"
  intercom-wake pal "Run test verification"
`);
}

const { to, msg, help } = parseWakeArgs(process.argv.slice(2));

if (help) {
  printUsage();
  process.exit(0);
}

if (!to || !msg) {
  printUsage();
  process.exit(1);
}

wakeAgent(to, msg, () => {
  process.exit(0);
});
