#!/usr/bin/env node
// bin/intercom-wake.js - Auto-Wake Executable Shortcut
const { wakeAgent } = require('../src/controllers/autowake');

const args = process.argv.slice(2);
const toIdx = args.indexOf('--to') !== -1 ? args.indexOf('--to') : (args[0] && !args[0].startsWith('-') ? 0 : -1);
const msgIdx = args.indexOf('--msg') !== -1 ? args.indexOf('--msg') : (args[1] && !args[1].startsWith('-') ? 1 : -1);

let to = null;
let msg = null;

if (args.includes('--to')) {
  to = args[args.indexOf('--to') + 1];
} else if (args[0] && !args[0].startsWith('-')) {
  to = args[0];
}

if (args.includes('--msg')) {
  msg = args[args.indexOf('--msg') + 1];
} else if (args[1] && !args[1].startsWith('-')) {
  msg = args[1];
}

if (!to || !msg) {
  console.log(`
⚡ Intercom Auto-Wake Shortcut

Usage:
  intercom-wake <targetName> "<task>"
  intercom-wake --to <targetName> --msg "<task>"

Examples:
  intercom-wake Keshav "Check customer routes"
  intercom-wake pal "Run test verification"
`);
  process.exit(1);
}

wakeAgent(to, msg, () => {
  setTimeout(() => process.exit(0), 400);
});
