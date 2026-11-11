#!/usr/bin/env node
// scripts/live-scrape-sync.js - CLI Runner for Live Registry Sync, Purification & MD Hydration
const fs = require('fs');
const path = require('path');
const { ROOT_DIR, MESH_DIR } = require('../src/config');
const {
  syncLiveRegistry,
  scrapeUrl,
  buildDynamicContext,
  hydrateMarkdown
} = require('../src/live-scraper');

function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    force: false,
    quiet: false,
    json: false,
    hydrate: false,
    write: false,
    inPlace: false,
    vars: false,
    target: null,
    outDir: null,
    url: null,
    timeoutMs: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') opts.force = true;
    else if (arg === '--quiet' || arg === '-q') opts.quiet = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--hydrate') {
      opts.hydrate = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        opts.target = argv[++i];
      }
    } else if (arg === '--write') opts.write = true;
    else if (arg === '--in-place') opts.inPlace = true;
    else if (arg === '--vars') opts.vars = true;
    else if (arg === '--out-dir' && argv[i + 1]) opts.outDir = argv[++i];
    else if (arg === '--url' && argv[i + 1]) opts.url = argv[++i];
    else if (arg === '--timeout' && argv[i + 1]) opts.timeoutMs = parseInt(argv[++i], 10);
  }
  return opts;
}

function collectDefaultMarkdownFiles() {
  const candidates = [
    path.join(ROOT_DIR, 'README.md'),
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

  if (opts.url) {
    const scraped = await scrapeUrl(opts.url, { timeoutMs: opts.timeoutMs || undefined });
    if (!opts.quiet) {
      if (opts.json) {
        console.log(JSON.stringify(scraped, null, 2));
      } else {
        console.log(scraped.ok ? scraped.content : `Error scraping ${opts.url}: ${scraped.error}`);
      }
    }
    return scraped;
  }

  const snapshot = await syncLiveRegistry({
    force: opts.force,
    timeoutMs: opts.timeoutMs || undefined
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
    const outDir = opts.outDir ? path.resolve(process.cwd(), opts.outDir) : path.join(MESH_DIR, 'hydrated');
    const hydratedResults = [];

    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const rendered = hydrateMarkdown(raw, vars);
      let destPath = null;

      if (opts.inPlace) {
        destPath = file;
        fs.writeFileSync(destPath, rendered, 'utf8');
      } else if (opts.write) {
        const rel = path.relative(ROOT_DIR, file);
        destPath = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, rendered, 'utf8');
      }
      hydratedResults.push({ file, destPath, length: rendered.length, content: rendered });
    }

    if (!opts.quiet) {
      if (opts.json) {
        console.log(JSON.stringify(hydratedResults.map(r => ({ file: r.file, destPath: r.destPath, length: r.length })), null, 2));
      } else if (files.length === 1 && !opts.write && !opts.inPlace && hydratedResults[0]) {
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
