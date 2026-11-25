#!/usr/bin/env node
// scripts/live-scrape-sync.js - CLI Runner for Live Registry Sync, Purification & MD Hydration
const fs = require('fs');
const path = require('path');
const { ROOT_DIR, getMeshDir } = require('../src/config');
const { resolveSafePath, atomicWriteFileSync } = require('../src/core/mesh');
const {
  syncLiveRegistry,
  scrapeUrl,
  buildDynamicContext,
  hydrateMarkdown
} = require('../src/live-scraper');

function resolveContainedRelativePath(baseDir, filePath) {
  const resolvedRoot = path.resolve(ROOT_DIR);
  const resolvedFile = path.resolve(filePath);
  const rel = path.relative(resolvedRoot, resolvedFile);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new Error(`SecurityError: Cannot map "${filePath}" safely inside "${baseDir}"`);
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`SecurityError: Empty relative path for "${filePath}"`);
  }
  let current = path.resolve(baseDir);
  for (const seg of segments) {
    current = resolveSafePath(current, seg);
  }
  return current;
}

function parseNumericArg(flagName, rawValue, { min = 0, integer = true } = {}) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return { ok: false, error: `Missing value for ${flagName}` };
  }
  const trimmed = String(rawValue).trim();
  const num = Number(trimmed);
  if (!Number.isFinite(num) || (integer && !Number.isInteger(num)) || num < min) {
    return {
      ok: false,
      error: `Invalid numeric value for ${flagName}: "${rawValue}" (expected ${integer ? 'integer' : 'number'} >= ${min})`
    };
  }
  return { ok: true, value: num };
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    force: false,
    offline: false,
    quiet: false,
    json: false,
    hydrate: false,
    write: false,
    inPlace: false,
    vars: false,
    help: false,
    target: null,
    outDir: null,
    out: null,
    cachePath: null,
    url: null,
    timeoutMs: null,
    ttlMs: null,
    errors: []
  };

  const readValue = (idx, eqVal, flagName) => {
    if (eqVal !== null) return { val: eqVal, nextIdx: idx };
    const next = argv[idx + 1];
    if (next === undefined || next.startsWith('-')) {
      opts.errors.push(`Missing value for ${flagName}`);
      return { val: null, nextIdx: idx };
    }
    return { val: next, nextIdx: idx + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eqIdx = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
    const eqVal = eqIdx !== -1 ? arg.slice(eqIdx + 1) : null;

    if (flag === '--force' || flag === '-f') {
      opts.force = true;
    } else if (flag === '--offline') {
      opts.offline = true;
    } else if (flag === '--quiet' || flag === '-q') {
      opts.quiet = true;
    } else if (flag === '--json') {
      opts.json = true;
    } else if (flag === '--help' || flag === '-h') {
      opts.help = true;
    } else if (flag === '--hydrate') {
      opts.hydrate = true;
      if (eqVal !== null) {
        if (!eqVal) opts.errors.push('Missing value for --hydrate=');
        else opts.target = eqVal;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        opts.target = argv[++i];
      }
    } else if (flag === '--write') {
      opts.write = true;
    } else if (flag === '--in-place') {
      opts.inPlace = true;
    } else if (flag === '--vars') {
      opts.vars = true;
    } else if (flag === '--out-dir') {
      const { val, nextIdx } = readValue(i, eqVal, '--out-dir');
      i = nextIdx;
      if (val !== null) opts.outDir = val;
    } else if (flag === '--out') {
      const { val, nextIdx } = readValue(i, eqVal, '--out');
      i = nextIdx;
      if (val !== null) opts.out = val;
    } else if (flag === '--cache') {
      const { val, nextIdx } = readValue(i, eqVal, '--cache');
      i = nextIdx;
      if (val !== null) opts.cachePath = val;
    } else if (flag === '--url') {
      const { val, nextIdx } = readValue(i, eqVal, '--url');
      i = nextIdx;
      if (val !== null) opts.url = val;
    } else if (flag === '--timeout') {
      const { val, nextIdx } = readValue(i, eqVal, '--timeout');
      i = nextIdx;
      if (val !== null) {
        const parsed = parseNumericArg('--timeout', val, { min: 0, integer: true });
        if (!parsed.ok) opts.errors.push(parsed.error);
        else opts.timeoutMs = parsed.value;
      }
    } else if (flag === '--ttl') {
      const { val, nextIdx } = readValue(i, eqVal, '--ttl');
      i = nextIdx;
      if (val !== null) {
        const parsed = parseNumericArg('--ttl', val, { min: 0, integer: false });
        if (!parsed.ok) opts.errors.push(parsed.error);
        else opts.ttlMs = Math.round(parsed.value * 60 * 1000);
      }
    } else if (arg.startsWith('-')) {
      opts.errors.push(`Unknown flag: ${arg}`);
    } else {
      opts.errors.push(`Unexpected positional argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: intercom sync [options]
       node scripts/live-scrape-sync.js [options]

Options:
  -f, --force               Bypass cache TTL and force fresh live scrape
      --offline             Skip network calls and resolve from cache/local state
      --timeout <ms>        Per-endpoint network timeout in ms (0 = unlimited)
      --ttl <minutes>       Cache TTL in minutes (0 = bypass cache)
      --cache <path>        Override purified cache file path
      --url <url>           Scrape and ultra-purify a specific web URL
      --vars                Output resolved canonical dynamic variable dictionary
      --hydrate [file.md]   Hydrate {{VAR}} tokens in Markdown file(s)
      --write               Write hydrated files into --out-dir (default: mesh/hydrated)
      --out-dir <dir>       Output directory for --write
      --out <file.md>       Write single hydrated target to destination file
      --in-place            Update hydrated Markdown file(s) in place
  -q, --quiet               Suppress stdout output
      --json                Output machine-readable JSON
  -h, --help                Show this help manual
`);
}

function collectDefaultMarkdownFiles() {
  const candidates = [
    path.join(ROOT_DIR, 'README.md'),
    path.join(ROOT_DIR, 'AGENTS.md'),
    path.join(ROOT_DIR, 'skills', 'intercom-global', 'SKILL.md')
  ];
  const docsDir = path.join(ROOT_DIR, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const entry of fs.readdirSync(docsDir)) {
      if (entry.endsWith('.md')) {
        candidates.push(path.join(docsDir, entry));
      }
    }
  }
  return candidates.filter(p => fs.existsSync(p));
}

async function runSyncCli(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);

  if (opts.help) {
    if (!opts.quiet) printHelp();
    return { ok: true, help: true };
  }

  if (opts.errors.length > 0) {
    if (!opts.quiet) {
      for (const errMsg of opts.errors) {
        console.error(`[LIVE SCRAPE SYNC ERROR]: ${errMsg}`);
      }
    }
    process.exitCode = 1;
    return { ok: false, errors: opts.errors };
  }

  if (opts.url) {
    const scraped = await scrapeUrl(opts.url, {
      ...(opts.timeoutMs !== null ? { timeoutMs: opts.timeoutMs } : {})
    });
    if (!scraped.ok) process.exitCode = 1;
    if (!opts.quiet) {
      if (opts.json) {
        console.log(JSON.stringify(scraped, null, 2));
      } else if (scraped.ok) {
        console.log(scraped.content);
      } else {
        console.error(`Error scraping ${opts.url}: ${scraped.error}`);
      }
    }
    return scraped;
  }

  const snapshot = await syncLiveRegistry({
    force: opts.force,
    offline: opts.offline,
    ...(opts.timeoutMs !== null ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.ttlMs !== null ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.cachePath ? { cachePath: path.resolve(process.cwd(), opts.cachePath) } : {})
  });
  const vars = buildDynamicContext(snapshot);

  if (opts.vars) {
    if (!opts.quiet) console.log(JSON.stringify(vars, null, 2));
    return { snapshot, vars };
  }

  if (opts.hydrate) {
    const files = opts.target
      ? [path.isAbsolute(opts.target) ? opts.target : path.resolve(process.cwd(), opts.target)]
      : collectDefaultMarkdownFiles();

    const outDir = opts.outDir ? path.resolve(process.cwd(), opts.outDir) : path.join(getMeshDir(), 'hydrated');
    if (opts.write) {
      for (const file of files) {
        resolveContainedRelativePath(outDir, file);
      }
    }

    if (opts.target && files.length === 1 && !fs.existsSync(files[0])) {
      const msg = `Markdown target not found: ${opts.target}`;
      if (!opts.quiet) console.error(`[LIVE SCRAPE SYNC ERROR]: ${msg}`);
      process.exitCode = 1;
      return { ok: false, error: msg };
    }

    if (opts.out && files.length > 1) {
      const msg = '--out can only be used with a single --hydrate <file> target';
      if (!opts.quiet) console.error(`[LIVE SCRAPE SYNC ERROR]: ${msg}`);
      process.exitCode = 1;
      return { ok: false, error: msg };
    }

    const hydratedResults = [];

    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const rendered = hydrateMarkdown(raw, vars);
      let destPath = null;

      if (opts.out) {
        destPath = path.resolve(process.cwd(), opts.out);
        atomicWriteFileSync(destPath, rendered, 'utf8');
      } else if (opts.inPlace) {
        destPath = file;
        atomicWriteFileSync(destPath, rendered, 'utf8');
      } else if (opts.write) {
        destPath = resolveContainedRelativePath(outDir, file);
        atomicWriteFileSync(destPath, rendered, 'utf8');
      }
      hydratedResults.push({ file, destPath, length: rendered.length, content: rendered });
    }

    if (!opts.quiet) {
      if (opts.json) {
        console.log(JSON.stringify(hydratedResults.map(r => ({ file: r.file, destPath: r.destPath, length: r.length })), null, 2));
      } else if (files.length === 1 && !opts.write && !opts.inPlace && !opts.out && hydratedResults[0]) {
        console.log(hydratedResults[0].content);
      } else {
        console.log(`[HYDRATE] Rendered ${hydratedResults.length} markdown file(s) using ${Object.keys(vars).length} live variables.`);
        for (const r of hydratedResults) {
          console.log(`  - ${path.relative(ROOT_DIR, r.file)}${r.destPath ? ` -> ${r.destPath}` : ''}`);
        }
      }
    }
    return { snapshot, vars, hydrated: hydratedResults };
  }

  if (!opts.quiet) {
    if (opts.json) {
      console.log(JSON.stringify({
        syncedAt: snapshot.syncedAt,
        fromCache: snapshot.fromCache,
        offlineFallback: snapshot.offlineFallback,
        sources: snapshot.sources,
        stats: snapshot.stats,
        defaultModel: vars.DEFAULT_MODEL,
        topFreeModels: vars.TOP_FREE_MODELS,
        activeHarnesses: vars.ACTIVE_HARNESSES,
        activePeersCount: Number(vars.ACTIVE_PEERS_COUNT)
      }, null, 2));
    } else {
      console.log(`[LIVE SCRAPE SYNC] ${snapshot.fromCache ? 'CACHE HIT' : (snapshot.offlineFallback ? 'OFFLINE FALLBACK' : 'LIVE SYNCED')} @ ${snapshot.syncedAt}`);
      console.log(`  Models       : ${snapshot.stats?.deduplicatedCount || snapshot.models.length} purified (${snapshot.stats?.freeModelCount || snapshot.freeModels.length} free)`);
      console.log(`  Default Model: ${vars.DEFAULT_MODEL}`);
      console.log(`  Harnesses    : ${vars.ACTIVE_HARNESSES}`);
      console.log(`  Active Peers : ${vars.ACTIVE_PEERS_COUNT} (${vars.ACTIVE_PEERS_LIST})`);
    }
  }

  return { snapshot, vars };
}

module.exports = {
  parseCliArgs,
  runSyncCli
};

if (require.main === module) {
  runSyncCli().catch((err) => {
    if (!process.argv.includes('--quiet') && !process.argv.includes('-q')) {
      console.error(`[LIVE SCRAPE SYNC ERROR]: ${err.message}`);
    }
    process.exitCode = 1;
  });
}
