// src/live-scraper.js - Live Open Registry Scraper, Ultra-Purified Parser & Dynamic MD Hydrator
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PORT, MESH_DIR, ROOT_DIR, getMeshDir } = require('./config');
const { isEphemeralMailboxName, retryNtfsOperationSync } = require('./core/mesh');
const { getLedgerPath } = require('./core/jules-delegator');

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const OFFLINE_COOLDOWN_MS = 2 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CACHE_PATH = path.join(MESH_DIR, 'purified-live-cache.json');

const SCRAPE_SOURCES = [
  { id: 'models_dev', url: 'https://models.dev/api.json', kind: 'models_dev' },
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1/models', kind: 'openrouter' }
];

// Zero-Qoder Policy: Qoder is strictly barred from auto-routing and default fallback chains.
// Explicit Qoder invocations are restricted exclusively to verified free-tier models.
const QODER_ALLOWED_MODELS = [
  'qwen3.8-flash',
  'qwen3.8',
  'qoder/qwen3.8-flash',
  'glm-5.3-flash',
  'deepseek-flash',
  'minimax-m3.1-flash'
];

const SUPPORTED_HARNESSES = [
  { name: 'opencode', binary: 'opencode', streaming: true, sessions: true, reasoning: true, sandbox: true, tier: 1, barredAuto: false },
  { name: 'claude', binary: 'claude', streaming: true, sessions: true, reasoning: true, sandbox: true, tier: 2, barredAuto: false },
  { name: 'hermes', binary: 'hermes', streaming: true, sessions: true, reasoning: true, sandbox: false, tier: 2, barredAuto: false },
  { name: 'pi', binary: 'pi', streaming: true, sessions: true, reasoning: true, sandbox: true, tier: 2, barredAuto: false },
  { name: 'jules', binary: 'jules', streaming: false, sessions: true, reasoning: true, sandbox: true, tier: 3, barredAuto: false },
  { name: 'codex', binary: 'codex', streaming: true, sessions: true, reasoning: true, sandbox: true, tier: 3, barredAuto: false },
  { name: 'mcode', binary: 'mcode', streaming: true, sessions: false, reasoning: true, sandbox: false, tier: 3, barredAuto: false },
  { name: 'cursor', binary: 'cursor', streaming: true, sessions: true, reasoning: true, sandbox: true, tier: 2, barredAuto: false },
  { name: 'windsurf', binary: 'windsurf', streaming: true, sessions: true, reasoning: true, sandbox: true, tier: 2, barredAuto: false },
  { name: 'vscode', binary: 'code', streaming: true, sessions: true, reasoning: false, sandbox: true, tier: 2, barredAuto: false },
  { name: 'antigravity', binary: 'antigravity', streaming: true, sessions: true, reasoning: true, sandbox: true, tier: 1, barredAuto: false },
  { name: 'qoder', binary: 'qoder', streaming: true, sessions: true, reasoning: true, sandbox: true, tier: 99, barredAuto: true },
  { name: 'custom', binary: null, streaming: false, sessions: false, reasoning: false, sandbox: false, tier: 4, barredAuto: false }
];

const CURATED_BASELINE_MODELS = [
  {
    id: 'opencode/glm-5.3-flash-free',
    name: 'GLM-5.3 Flash Free',
    provider: 'opencode',
    isFree: true,
    promptCost: 0,
    completionCost: 0,
    contextWindow: 200000,
    reasoning: true,
    toolCall: true,
    source: 'baseline'
  },
  {
    id: 'opencode/deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    provider: 'opencode',
    isFree: true,
    promptCost: 0,
    completionCost: 0,
    contextWindow: 128000,
    reasoning: true,
    toolCall: true,
    source: 'baseline'
  },
  {
    id: 'minimax/MiniMax-M3.1-Flash-Preview',
    name: 'MiniMax M3.1 Flash Preview',
    provider: 'minimax',
    isFree: true,
    promptCost: 0,
    completionCost: 0,
    contextWindow: 200000,
    reasoning: true,
    toolCall: true,
    source: 'baseline'
  },
  {
    id: 'google/gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    provider: 'google',
    isFree: false,
    promptCost: 0.00000075,
    completionCost: 0.00000375,
    contextWindow: 1048576,
    reasoning: true,
    toolCall: true,
    source: 'baseline'
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    isFree: false,
    promptCost: 3,
    completionCost: 15,
    contextWindow: 200000,
    reasoning: true,
    toolCall: true,
    source: 'baseline'
  }
];

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid',
  '_ga', '_gl', 'ref_src', 'ref_url', 'spm', 'yclid', 'wickedid'
]);

const PROMPT_INJECTION_PATTERNS = [
  /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>|<\|endoftext\|>|<\|eot_id\|>|<\|start_header_id\|>|<\|end_header_id\|>/gi,
  /<\/?(?:system|developer|instructions?|prompt_override|system_prompt)\b[^>]*>[\s\S]*?<\/(?:system|developer|instructions?|prompt_override|system_prompt)\s*>|<\/?(?:system|developer|instructions?|prompt_override|system_prompt)\b[^>]*>/gi,
  /\[\/?INST\]|<<\/?SYS>>|\[SYSTEM OVERRIDE\]|\[ADMIN OVERRIDE\]/gi,
  /^(?:###\s*)?(?:SYSTEM|DEVELOPER)\s*(?:PROMPT|OVERRIDE|INSTRUCTION)\s*:.*$/gim,
  /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|directives?)[^.\n]*/gi,
  /you\s+are\s+now\s+(?:in\s+)?(?:DAN|developer|jailbreak|unrestricted)(?:\s+mode)?\b[^.\n]*/gi,
  /(?:override|bypass|disable)\s+(?:all\s+)?(?:safety|security|guardrails|policies|filters)[^.\n]*/gi,
  /(?:reveal|print|dump|leak|exfiltrate)\s+(?:your\s+)?(?:system\s+prompt|hidden\s+instructions?|api\s*keys?|secrets?|environment\s+variables?)[^.\n]*/gi
];

const HTML_NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  mdash: '-',
  ndash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  copy: '(c)',
  reg: '(R)',
  trade: '(TM)'
};

/**
 * Strips C0/C1 control characters and invisible/zero-width/bidi-override Unicode characters.
 * Preserves standard newlines and tabs while normalizing CRLF to LF.
 * @param {string} input
 * @returns {string}
 */
function stripControlAndInvisible(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
}

/**
 * Decodes standard named and numeric HTML entities safely.
 * @param {string} input
 * @returns {string}
 */
function decodeHtmlEntities(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/&([a-zA-Z0-9]+|#\d+|#x[0-9a-fA-F]+);/g, (match, entity) => {
    const lower = entity.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(HTML_NAMED_ENTITIES, lower)) {
      return HTML_NAMED_ENTITIES[lower];
    }
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      return isSafePrintableCodePoint(code) ? String.fromCodePoint(code) : '';
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      return isSafePrintableCodePoint(code) ? String.fromCodePoint(code) : '';
    }
    return match;
  });
}

function isSafePrintableCodePoint(code) {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10FFFF) return false;
  if (code >= 0xD800 && code <= 0xDFFF) return false;
  if (code < 32 && code !== 9 && code !== 10) return false;
  if (code >= 0x7F && code <= 0x9F) return false;
  return true;
}

/**
 * Strips marketing/tracking query parameters from URLs inside text.
 * @param {string} input
 * @returns {string}
 */
function stripTrackingParamsFromText(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (rawUrl) => {
    try {
      const trailingMatch = rawUrl.match(/[.,;:!?]+$/);
      const trailing = trailingMatch ? trailingMatch[0] : '';
      const cleanRaw = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
      const parsed = new URL(cleanRaw);
      let changed = false;
      for (const key of Array.from(parsed.searchParams.keys())) {
        const lowerKey = key.toLowerCase();
        if (TRACKING_QUERY_PARAMS.has(lowerKey) || lowerKey.startsWith('utm_')) {
          parsed.searchParams.delete(key);
          changed = true;
        }
      }
      if (!changed) return rawUrl;
      return parsed.toString() + trailing;
    } catch {
      return rawUrl;
    }
  });
}

/**
 * Removes known prompt-injection delimiters and instruction-override directives.
 * @param {string} input
 * @returns {{ text: string, strippedCount: number }}
 */
function stripPromptInjections(input) {
  if (typeof input !== 'string') return { text: '', strippedCount: 0 };
  let text = input;
  let strippedCount = 0;

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    text = text.replace(pattern, () => {
      strippedCount += 1;
      return ' ';
    });
  }

  return { text, strippedCount };
}

/**
 * Collapses repeated whitespace and normalizes blank lines cleanly.
 * @param {string} input
 * @returns {string}
 */
function collapseWhitespace(input) {
  if (typeof input !== 'string') return '';
  return input
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const AD_CHROME_ATTR_RE = /(?:(?:class|id)\s*=\s*["'][^"']*\b(?:ad-banner|ad-slot|ads|advertisement|cookie-banner|cookie-consent|tracking|analytics|telemetry|promo-banner|sponsor|newsletter-popup|sidebar-ad)\b[^"']*["']|style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["']|\bhidden\b|aria-hidden\s*=\s*["']true["'])/i;

function stripExecutableAndChromeBlocks(text) {
  let out = text;
  const strippedBlockTags = [
    'script', 'style', 'noscript', 'svg', 'template',
    'iframe', 'object', 'embed', 'canvas'
  ];
  for (const tag of strippedBlockTags) {
    const blockRegex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    out = out.replace(blockRegex, ' ');
    const selfCloseRegex = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    out = out.replace(selfCloseRegex, ' ');
  }

  // Strip balanced layout chrome tags innermost-first (bounded passes, linear per match)
  for (const tag of ['nav', 'footer', 'header', 'aside', 'form']) {
    const re = new RegExp(`<${tag}\\b[^>]*>(?:(?!<${tag}\\b)[\\s\\S])*?<\\/${tag}>`, 'gi');
    let prev;
    for (let pass = 0; pass < 6; pass++) {
      prev = out;
      out = out.replace(re, ' ');
      if (out === prev) break;
    }
  }

  // Strip hidden/ad/tracking containers safely without nested attribute backtracking
  for (const tag of ['div', 'section', 'span', 'p', 'ul']) {
    const re = new RegExp(`<${tag}\\b([^>]*)>((?:(?!<${tag}\\b)[\\s\\S])*?)<\\/${tag}>`, 'gi');
    let prev;
    for (let pass = 0; pass < 5; pass++) {
      prev = out;
      out = out.replace(re, (full, attrs) => (AD_CHROME_ATTR_RE.test(attrs) ? ' ' : full));
      if (out === prev) break;
    }
  }
  return out;
}

/**
 * Ultra-purifies HTML into clean normalized Markdown/text, stripping scripts, styles,
 * SVGs, navigation/footer/ad/tracking containers, hidden nodes, entities, and injections.
 * @param {string} rawHtml
 * @returns {{ content: string, strippedInjections: number }}
 */
function purifyHtmlInternal(rawHtml) {
  if (typeof rawHtml !== 'string') return { content: '', strippedInjections: 0 };

  let text = stripControlAndInvisible(rawHtml);

  // 1. Strip HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  // 2-3. Strip executable, styling, media-chrome, layout boilerplate, and ad/hidden containers
  text = stripExecutableAndChromeBlocks(text);

  // 4. Convert safe links while neutralizing javascript:/data: hrefs
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs, inner) => {
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const label = inner.replace(/<[^>]+>/g, '').trim();
    if (!hrefMatch) return label;
    const href = hrefMatch[1].trim();
    if (/^(javascript|data|vbscript):/i.test(href)) {
      return label;
    }
    const cleanedHref = stripTrackingParamsFromText(href);
    return label ? `[${label}](${cleanedHref})` : cleanedHref;
  });

  // 5. Preserve structural markdown spacing for headings, lists, and paragraphs
  text = text
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' | ');

  // 6. Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // 7. Decode entities and re-scrub decoded invisibles & hidden executable tags (second pass)
  text = decodeHtmlEntities(text);
  text = stripControlAndInvisible(text);
  if (/<(?:script|style|noscript|svg|iframe|object|embed|template|img|video|audio|meta|link|base)\b/i.test(text)) {
    text = stripExecutableAndChromeBlocks(text);
    text = text.replace(/<\/?(?:img|video|audio|source|meta|link|base|body|html)\b[^>]*>/gi, ' ');
    text = stripControlAndInvisible(text);
  }
  text = stripTrackingParamsFromText(text);
  const inj = stripPromptInjections(text);
  return {
    content: collapseWhitespace(inj.text),
    strippedInjections: inj.strippedCount
  };
}

/**
 * Ultra-purifies HTML, JSON, or plain text into clean, injection-free content.
 * @param {string|object} rawInput
 * @param {object} [options] { format?: 'auto'|'html'|'json'|'text', withStats?: boolean }
 * @returns {string|{ content: string, stats: { strippedInjections: number, format: string } }}
 */
function purifyContent(rawInput, options = {}) {
  const format = options.format || 'auto';
  let detected = format;

  if (rawInput === null || rawInput === undefined) {
    return options.withStats
      ? { content: '', stats: { strippedInjections: 0, format: 'empty' } }
      : '';
  }

  if (typeof rawInput === 'object') {
    const purifiedObj = purifyJsonValue(rawInput);
    const serialized = JSON.stringify(purifiedObj.value, null, 2);
    return options.withStats
      ? { content: serialized, stats: { strippedInjections: purifiedObj.strippedInjections, format: 'json' } }
      : serialized;
  }

  const str = String(rawInput);
  if (detected === 'auto') {
    const trimmed = str.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed);
        detected = 'json';
      } catch {
        detected = /<!doctype|<html|<script|<style|<div|<p|<span|<body|<h[1-6]\b/i.test(str) ? 'html' : 'text';
      }
    } else if (/<!doctype|<html|<script|<style|<div|<p|<span|<body|<h[1-6]\b|<a\b/i.test(str)) {
      detected = 'html';
    } else {
      detected = 'text';
    }
  }

  if (detected === 'json') {
    try {
      const parsed = JSON.parse(str);
      const purifiedObj = purifyJsonValue(parsed);
      const serialized = JSON.stringify(purifiedObj.value, null, 2);
      return options.withStats
        ? { content: serialized, stats: { strippedInjections: purifiedObj.strippedInjections, format: 'json' } }
        : serialized;
    } catch {
      // Fallback to text purification if malformed JSON
    }
  }

  if (detected === 'html') {
    const res = purifyHtmlInternal(str);
    return options.withStats
      ? { content: res.content, stats: { strippedInjections: res.strippedInjections, format: 'html' } }
      : res.content;
  }

  let text = stripControlAndInvisible(decodeHtmlEntities(str));
  text = stripTrackingParamsFromText(text);
  const inj = stripPromptInjections(text);
  const content = collapseWhitespace(inj.text);
  return options.withStats
    ? { content, stats: { strippedInjections: inj.strippedCount, format: 'text' } }
    : content;
}

function purifyJsonValue(value, seen = new WeakSet()) {
  let strippedInjections = 0;
  if (typeof value === 'string') {
    let text = stripControlAndInvisible(decodeHtmlEntities(value));
    text = stripTrackingParamsFromText(text);
    const inj = stripPromptInjections(text);
    strippedInjections += inj.strippedCount;
    return { value: collapseWhitespace(inj.text), strippedInjections };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return { value: '[Circular]', strippedInjections: 0 };
    seen.add(value);
    const out = [];
    for (const item of value) {
      const res = purifyJsonValue(item, seen);
      strippedInjections += res.strippedInjections;
      out.push(res.value);
    }
    return { value: out, strippedInjections };
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return { value: '[Circular]', strippedInjections: 0 };
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleanKey = stripControlAndInvisible(String(k)).trim();
      if (!cleanKey || cleanKey === '__proto__' || cleanKey === 'constructor' || cleanKey === 'prototype') {
        continue;
      }
      const res = purifyJsonValue(v, seen);
      strippedInjections += res.strippedInjections;
      out[cleanKey] = res.value;
    }
    return { value: out, strippedInjections };
  }
  return { value, strippedInjections };
}

/**
 * Sanitizes model or harness identifiers by truncating at shell operators and
 * stripping shell metacharacters, whitespace, and control characters.
 * @param {string} rawId
 * @param {number} [maxLen=128]
 * @returns {string}
 */
function sanitizeIdentifier(rawId, maxLen = 128) {
  if (typeof rawId !== 'string') return '';
  const cleaned = stripControlAndInvisible(rawId)
    .trim()
    .split(/[;|&$`<>\r\n]/)[0]
    .replace(/[^a-zA-Z0-9._:/@-]/g, '')
    .slice(0, maxLen);
  return cleaned;
}

/**
 * Checks whether a model ID is an explicitly allowlisted Zero-Qoder free-tier model.
 * @param {string} modelId
 * @returns {boolean}
 */
function isQoderFreeModel(modelId) {
  const clean = sanitizeIdentifier(modelId).toLowerCase();
  if (!clean) return false;
  const bare = clean.includes('/') ? clean.split('/').pop() : clean;
  return QODER_ALLOWED_MODELS.includes(clean) || QODER_ALLOWED_MODELS.includes(bare);
}

/**
 * Enforces Zero-Qoder safety policy on harness and model entries.
 * @param {object} entry
 * @returns {{ allowed: boolean, barredAuto: boolean, reason?: string }}
 */
function enforceZeroQoderPolicy(entry = {}) {
  const id = sanitizeIdentifier(String(entry.id || entry.name || '')).toLowerCase();
  const provider = sanitizeIdentifier(String(entry.provider || '')).toLowerCase();

  if (id === 'qoder' || provider === 'qoder' || id.startsWith('qoder/')) {
    if (entry.type === 'harness' || id === 'qoder') {
      return {
        allowed: false,
        barredAuto: true,
        reason: 'Zero-Qoder invariant: qoder is barred from automatic routing and default fallback tiers'
      };
    }
    if (!isQoderFreeModel(id)) {
      return {
        allowed: false,
        barredAuto: true,
        reason: `Zero-Qoder invariant: model "${id}" is not on verified free-tier allowlist`
      };
    }
    return {
      allowed: true,
      barredAuto: true,
      reason: 'Allowed only for explicit free-tier Qoder invocation'
    };
  }

  return { allowed: true, barredAuto: false };
}

/**
 * Computes deterministic quality ranking score for a normalized model record.
 * @param {object} model
 * @returns {number}
 */
function scoreModel(model) {
  let score = 0;
  if (model.isFree) score += 40;
  if (model.reasoning) score += 20;
  if (model.toolCall) score += 15;

  const ctx = Number(model.contextWindow) || 0;
  if (ctx >= 1000000) score += 20;
  else if (ctx >= 200000) score += 15;
  else if (ctx >= 128000) score += 10;
  else if (ctx >= 32000) score += 5;

  const trustedProviders = new Set(['opencode', 'google', 'anthropic', 'openai', 'deepseek', 'qwen', 'minimax', 'nvidia']);
  const prov = (model.provider || '').toLowerCase();
  if (trustedProviders.has(prov)) {
    score += 10;
  }
  const lowerId = (model.id || '').toLowerCase();
  if (model.isFree && (lowerId.endsWith('-free') || lowerId.endsWith(':free'))) {
    score += 5;
  }

  if (model.source === 'models_dev' || model.source === 'openrouter') {
    score += 5;
  }

  return score;
}

function normalizeModelRecord(raw, sourceId = 'unknown', statsAcc = null) {
  if (!raw || typeof raw !== 'object') return null;

  const id = sanitizeIdentifier(String(raw.id || raw.modelId || ''));
  if (!id || id.length < 2) return null;

  const provider = sanitizeIdentifier(
    String(raw.provider || (id.includes('/') ? id.split('/')[0] : 'unknown'))
  ).toLowerCase() || 'unknown';

  const policy = enforceZeroQoderPolicy({ id, provider });
  if (!policy.allowed) return null;

  const promptCost = parseFiniteNumber(raw.promptCost ?? raw.pricing?.prompt ?? raw.cost?.input);
  const completionCost = parseFiniteNumber(raw.completionCost ?? raw.pricing?.completion ?? raw.cost?.output);
  const hasFreeSuffix = id.toLowerCase().endsWith(':free') || id.toLowerCase().endsWith('-free');
  const isFree = Boolean(
    raw.isFree === true ||
    hasFreeSuffix ||
    (promptCost !== null && completionCost !== null && promptCost === 0 && completionCost === 0)
  );

  const contextWindow = Number(raw.contextWindow ?? raw.context_length ?? raw.limit?.context ?? 0) || 0;
  const supportedParams = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
  const reasoning = Boolean(
    raw.reasoning === true ||
    supportedParams.includes('reasoning') ||
    supportedParams.includes('include_reasoning') ||
    /r1|thinking|reasoning|flash|sonnet|opus|o1|o3|o4/i.test(id)
  );
  const toolCall = Boolean(
    raw.toolCall === true ||
    raw.tool_call === true ||
    supportedParams.includes('tools') ||
    supportedParams.includes('tool_choice')
  );

  const purifiedNameRes = purifyContent(String(raw.name || id), { format: 'text', withStats: true });
  if (statsAcc && purifiedNameRes?.stats?.strippedInjections) {
    statsAcc.strippedInjections += purifiedNameRes.stats.strippedInjections;
  }
  const purifiedName = purifiedNameRes?.content || id;
  const record = {
    id,
    name: purifiedName.slice(0, 120),
    provider,
    isFree,
    promptCost: promptCost ?? (isFree ? 0 : null),
    completionCost: completionCost ?? (isFree ? 0 : null),
    contextWindow,
    reasoning,
    toolCall,
    source: sourceId
  };
  record.score = scoreModel(record);
  return record;
}

function parseFiniteNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function pickCandidateFields(item, overrides = {}) {
  return {
    id: overrides.id ?? item.id ?? item.modelId,
    name: item.name,
    provider: overrides.provider ?? item.provider,
    isFree: item.isFree,
    promptCost: item.promptCost,
    completionCost: item.completionCost,
    pricing: item.pricing,
    cost: item.cost,
    contextWindow: item.contextWindow,
    context_length: item.context_length,
    limit: item.limit,
    supported_parameters: item.supported_parameters,
    reasoning: item.reasoning,
    toolCall: item.toolCall,
    tool_call: item.tool_call
  };
}

function extractModelsFromPayload(payload, sourceId, statsAcc = null) {
  const models = [];
  if (!payload || typeof payload !== 'object') return models;

  // Format 1: OpenRouter ({ data: [ ... ] }) or direct array
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : null);
  if (list) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const norm = normalizeModelRecord(pickCandidateFields(item), sourceId, statsAcc);
      if (norm) models.push(norm);
    }
    return models;
  }

  // Format 2: models.dev ({ providerKey: { id, models: { modelKey: { ... } } } })
  for (const [providerKey, providerBlock] of Object.entries(payload)) {
    if (providerKey === '__proto__' || providerKey === 'constructor' || providerKey === 'prototype') continue;
    if (!providerBlock || typeof providerBlock !== 'object' || !providerBlock.models || typeof providerBlock.models !== 'object') continue;
    for (const [modelKey, modelInfo] of Object.entries(providerBlock.models)) {
      if (modelKey === '__proto__' || modelKey === 'constructor' || modelKey === 'prototype') continue;
      if (!modelInfo || typeof modelInfo !== 'object') continue;
      const fullId = modelKey.includes('/') ? modelKey : `${providerKey}/${modelKey}`;
      const norm = normalizeModelRecord(
        pickCandidateFields(modelInfo, { id: fullId, provider: providerKey }),
        sourceId,
        statsAcc
      );
      if (norm) models.push(norm);
    }
  }

  return models;
}

/**
 * Purifies, deduplicates, enforces Zero-Qoder rules, and ranks model records from scraped sources.
 * @param {Array<{ sourceId: string, data: any }>} rawDatasets
 * @param {object} [options] { includeBaseline?: boolean }
 * @returns {{ models: object[], freeModels: object[], stats: object }}
 */
function purifyScrapedData(rawDatasets = [], options = {}) {
  const byId = new Map();
  let rawCount = 0;
  const statsAcc = { strippedInjections: 0 };

  const mergeEntry = (entry) => {
    if (!entry) return;
    const key = entry.id.toLowerCase();
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, entry);
      return;
    }
    const hasPaidCost = (entry.promptCost !== null && entry.promptCost > 0)
      || (entry.completionCost !== null && entry.completionCost > 0)
      || (existing.promptCost !== null && existing.promptCost > 0)
      || (existing.completionCost !== null && existing.completionCost > 0);
    const hasFreeSuffix = key.endsWith(':free') || key.endsWith('-free');
    const existingIsFallback = existing.source === 'baseline' || existing.source === 'stale-cache';
    const merged = {
      ...existing,
      name: existing.name.length >= entry.name.length ? existing.name : entry.name,
      isFree: hasFreeSuffix ? true : (hasPaidCost ? false : (existing.isFree || entry.isFree)),
      promptCost: entry.promptCost ?? existing.promptCost,
      completionCost: entry.completionCost ?? existing.completionCost,
      contextWindow: Math.max(existing.contextWindow || 0, entry.contextWindow || 0),
      reasoning: existing.reasoning || entry.reasoning,
      toolCall: existing.toolCall || entry.toolCall,
      source: existingIsFallback && entry.source !== 'baseline' ? entry.source : existing.source
    };
    merged.score = scoreModel(merged);
    byId.set(key, merged);
  };

  for (const ds of rawDatasets) {
    if (!ds || !ds.data) continue;
    const extracted = extractModelsFromPayload(ds.data, ds.sourceId || 'live', statsAcc);
    rawCount += extracted.length;
    for (const m of extracted) mergeEntry(m);
  }

  if (options.includeBaseline !== false || byId.size === 0) {
    for (const base of CURATED_BASELINE_MODELS) {
      const norm = normalizeModelRecord(base, 'baseline', statsAcc);
      if (norm) mergeEntry(norm);
    }
  }

  const allModels = Array.from(byId.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.contextWindow !== a.contextWindow) return b.contextWindow - a.contextWindow;
    return a.id.localeCompare(b.id);
  });

  const freeModels = allModels.filter(m => m.isFree);
  return {
    models: allModels,
    freeModels,
    stats: {
      rawExtracted: rawCount,
      deduplicatedCount: allModels.length,
      freeModelCount: freeModels.length,
      strippedInjections: statsAcc.strippedInjections
    }
  };
}

/**
 * Fetches a URL with strict HTTP(S) scheme validation and fast timeout (no timer leaks).
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, status: number, contentType: string, bodyText: string, json?: any, error?: string }>}
 */
async function fetchWithTimeout(url, options = {}) {
  const rawTimeout = options.timeoutMs;
  const parsedTimeout = rawTimeout !== undefined && rawTimeout !== null && rawTimeout !== '' ? Number(rawTimeout) : NaN;
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const capCandidate = options.maxResponseBytes !== undefined && options.maxResponseBytes !== null
    ? Number(options.maxResponseBytes)
    : NaN;
  const maxResponseBytes = Number.isFinite(capCandidate) && capCandidate >= 0
    ? capCandidate
    : DEFAULT_MAX_RESPONSE_BYTES;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { ok: false, status: 0, contentType: '', bodyText: '', error: `Unsupported protocol: ${parsedUrl.protocol}` };
    }
  } catch (err) {
    return { ok: false, status: 0, contentType: '', bodyText: '', error: `Invalid URL: ${err.message}` };
  }

  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 0, contentType: '', bodyText: '', error: 'fetch API unavailable' };
  }

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  try {
    const res = await fetchImpl(parsedUrl.toString(), {
      method: 'GET',
      redirect: options.redirect === 'follow' ? 'follow' : 'error',
      headers: {
        'Accept': 'application/json, text/html, text/plain;q=0.9',
        'User-Agent': 'intercom-global-live-scraper/2.0.0'
      },
      signal: controller.signal
    });

    const contentType = (res.headers && typeof res.headers.get === 'function')
      ? (res.headers.get('content-type') || '')
      : '';

    if (maxResponseBytes > 0 && res.headers && typeof res.headers.get === 'function') {
      const declaredLength = Number(res.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength > maxResponseBytes) {
        return {
          ok: false,
          status: res.status || 0,
          contentType,
          bodyText: '',
          error: `Response too large: content-length ${declaredLength} exceeds ${maxResponseBytes} byte cap`
        };
      }
    }

    let bodyText = '';
    if (maxResponseBytes > 0 && res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value ? value.byteLength : 0;
          if (received > maxResponseBytes) {
            try { await reader.cancel(); } catch {}
            return {
              ok: false,
              status: res.status || 0,
              contentType,
              bodyText: '',
              error: `Response too large: body exceeded ${maxResponseBytes} byte cap`
            };
          }
          if (value) chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        bodyText = chunks.join('');
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    } else {
      bodyText = typeof res.text === 'function' ? await res.text() : '';
      if (maxResponseBytes > 0 && Buffer.byteLength(bodyText, 'utf8') > maxResponseBytes) {
        return {
          ok: false,
          status: res.status || 0,
          contentType,
          bodyText: '',
          error: `Response too large: body exceeded ${maxResponseBytes} byte cap`
        };
      }
    }

    if (!res.ok) {
      return { ok: false, status: res.status, contentType, bodyText, error: `HTTP ${res.status}` };
    }

    let json = undefined;
    if (contentType.includes('json') || bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[')) {
      try {
        json = JSON.parse(bodyText);
      } catch {}
    }

    return { ok: true, status: res.status, contentType, bodyText, json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      bodyText: '',
      error: err && err.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : (err?.message || 'Network error')
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Scrapes and purifies a single live URL (HTML, JSON, or text).
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, url: string, format: string, content: string, json?: any, strippedInjections: number, error?: string }>}
 */
async function scrapeUrl(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    return { ok: false, url, format: 'none', content: '', strippedInjections: 0, error: res.error };
  }

  if (res.json !== undefined) {
    const purified = purifyContent(res.json, { format: 'json', withStats: true });
    return {
      ok: true,
      url,
      format: 'json',
      content: purified.content,
      json: JSON.parse(purified.content),
      strippedInjections: purified.stats.strippedInjections
    };
  }

  const purified = purifyContent(res.bodyText, { format: 'auto', withStats: true });
  return {
    ok: true,
    url,
    format: purified.stats.format,
    content: purified.content,
    strippedInjections: purified.stats.strippedInjections
  };
}

let _mcpToolsCache = { stamp: null, value: null };
let _cliCommandsCountCache = { stamp: null, value: null };
let _testStatsCache = { stamp: null, suitesCount: 0, testsCount: 0 };

function getFileStampSafe(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

function scanPathExecutables() {
  const available = new Set();
  const pathEnv = process.env.PATH || process.env.Path || '';
  if (!pathEnv) return available;

  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())
    : [''];
  const dirs = Array.from(new Set(pathEnv.split(path.delimiter).filter(Boolean)));

  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      let isRegularFile = false;
      try {
        if (entry.isFile()) {
          isRegularFile = true;
        } else if (entry.isSymbolicLink()) {
          isRegularFile = fs.statSync(path.join(dir, entry.name)).isFile();
        }
      } catch {
        isRegularFile = false;
      }
      if (!isRegularFile) continue;

      if (isWin) {
        const lower = entry.name.toLowerCase();
        for (const ext of exts) {
          if (lower.endsWith(ext)) {
            available.add(lower.slice(0, -ext.length));
            available.add(lower);
            break;
          }
        }
      } else {
        available.add(entry.name);
      }
    }
  }
  return available;
}

function isBinaryOnPath(binaryName, preScannedSet = null) {
  if (!binaryName) return false;
  const set = preScannedSet || scanPathExecutables();
  const key = process.platform === 'win32' ? binaryName.toLowerCase() : binaryName;
  return set.has(key);
}

function discoverMcpToolNames() {
  const fallback = [
    'send_message', 'receive_messages', 'interrupt_agent', 'get_agent_status', 'list_agents',
    'intercom_send', 'intercom_wake', 'intercom_watch', 'intercom_read', 'intercom_clear', 'intercom_list_peers'
  ];
  const serverPath = path.join(ROOT_DIR, 'src', 'mcp', 'server.js');
  const stamp = getFileStampSafe(serverPath);
  if (_mcpToolsCache.stamp === stamp && _mcpToolsCache.value) {
    return _mcpToolsCache.value;
  }
  let value = fallback;
  if (stamp !== 'missing') {
    try {
      const src = fs.readFileSync(serverPath, 'utf8');
      const blockMatch = src.match(/const\s+MCP_TOOLS\s*=\s*\[([\s\S]*?)\n\];/);
      if (blockMatch) {
        const found = [];
        const seen = new Set();
        const nameRe = /^\s*name\s*:\s*["']([a-z0-9_]+)["']/gm;
        let m;
        while ((m = nameRe.exec(blockMatch[1])) !== null) {
          if (!seen.has(m[1])) {
            seen.add(m[1]);
            found.push(m[1]);
          }
        }
        if (found.length > 0) value = found;
      }
    } catch {
      value = fallback;
    }
  }
  _mcpToolsCache = { stamp, value };
  return value;
}

function discoverCliCommandsCount() {
  const cliPath = path.join(ROOT_DIR, 'src', 'cli.js');
  const stamp = getFileStampSafe(cliPath);
  if (_cliCommandsCountCache.stamp === stamp && _cliCommandsCountCache.value !== null) {
    return _cliCommandsCountCache.value;
  }
  let value = 18;
  if (stamp !== 'missing') {
    try {
      const src = fs.readFileSync(cliPath, 'utf8');
      const blockMatch = src.match(/const\s+CLI_COMMANDS\s*=\s*\[([\s\S]*?)\];/);
      if (blockMatch) {
        const found = new Set();
        const cmdRe = /["']([a-z][a-z0-9-]*)["']/g;
        let m;
        while ((m = cmdRe.exec(blockMatch[1])) !== null) {
          found.add(m[1]);
        }
        if (found.size > 0) value = found.size;
      }
    } catch {
      value = 18;
    }
  }
  _cliCommandsCountCache = { stamp, value };
  return value;
}

function countTestsAndSuites() {
  const testDir = path.join(ROOT_DIR, 'test');
  const unitDir = path.join(testDir, 'unit');
  const helpersDir = path.join(testDir, 'helpers');
  const dirStamp = [testDir, unitDir, helpersDir].map(getFileStampSafe).join('|');
  if (_testStatsCache.stamp === dirStamp && _testStatsCache.suitesCount > 0) {
    return { suitesCount: _testStatsCache.suitesCount, testsCount: _testStatsCache.testsCount };
  }

  const testFiles = [];
  for (const dir of [testDir, unitDir, helpersDir]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.test.js')) {
          testFiles.push(path.join(dir, entry));
        }
      }
    } catch {}
  }

  let testsCount = 0;
  const testDeclRe = /^\s*(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/gm;
  for (const file of testFiles) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      const matches = src.match(testDeclRe);
      if (matches) testsCount += matches.length;
    } catch {}
  }

  const suitesCount = testFiles.length;
  _testStatsCache = { stamp: dirStamp, suitesCount, testsCount };
  return { suitesCount, testsCount };
}

/**
 * Probes local environment (package metadata, PATH harnesses, MCP tools, CLI commands, and mesh peers).
 * Executes in-memory/filesystem checks only (<10ms, zero child spawns, zero stdout).
 * @returns {object}
 */
function probeLocalRuntime() {
  let pkg = {
    name: '@advance/intercom-global',
    version: '2.0.0',
    engines: { node: '>=18.0.0' },
    repository: { url: 'https://github.com/Suran123s/intercom-global' }
  };
  try {
    const pkgPath = path.join(ROOT_DIR, 'package.json');
    if (fs.existsSync(pkgPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    }
  } catch {}

  const pathExecs = scanPathExecutables();
  const harnesses = SUPPORTED_HARNESSES.map((h) => {
    const installed = h.binary ? isBinaryOnPath(h.binary, pathExecs) : false;
    return {
      ...h,
      installed,
      status: h.barredAuto ? 'BARRED_AUTO' : (installed ? 'INSTALLED' : 'AVAILABLE')
    };
  });

  const mcpToolNames = discoverMcpToolNames();
  const cliCommandsCount = discoverCliCommandsCount();
  const { suitesCount: testSuitesCount, testsCount: realTestsCount } = countTestsAndSuites();

  // Mesh peers & pending tasks (excluding ephemeral test mailboxes)
  const meshDir = getMeshDir();
  const activePeersSet = new Set();
  let activeTasksCount = 0;
  let totalTasksCount = 0;
  let sampleTaskId = `task-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-001`;
  let activeSessionsCount = 0;
  let sampleSessionId = `sess-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-001`;

  try {
    const regDir = path.join(meshDir, 'registry');
    if (fs.existsSync(regDir)) {
      for (const f of fs.readdirSync(regDir)) {
        if (!f.endsWith('.json') || f === 'reuse-tracker.json') continue;
        try {
          const card = JSON.parse(fs.readFileSync(path.join(regDir, f), 'utf8'));
          if (card && card.name && card.status !== 'OFFLINE' && !isEphemeralMailboxName(card.name)) {
            activePeersSet.add(sanitizeIdentifier(card.name));
          }
        } catch {}
      }
    }

    const inboxBase = path.join(meshDir, 'inbox');
    if (fs.existsSync(inboxBase)) {
      for (const entry of fs.readdirSync(inboxBase, { withFileTypes: true })) {
        if (!entry.isDirectory() || isEphemeralMailboxName(entry.name)) continue;
        activePeersSet.add(sanitizeIdentifier(entry.name));
        const files = fs.readdirSync(path.join(inboxBase, entry.name)).filter(x => x.endsWith('.json'));
        activeTasksCount += files.length;
        totalTasksCount += files.length;
        if (files.length > 0) {
          sampleTaskId = sanitizeIdentifier(files[files.length - 1].replace(/\.json$/, '')) || sampleTaskId;
        }
      }
    }

    const handoffsDir = path.join(meshDir, 'handoffs');
    if (fs.existsSync(handoffsDir)) {
      const hFiles = fs.readdirSync(handoffsDir).filter(f => f.endsWith('.json'));
      totalTasksCount += hFiles.length;
      if (hFiles.length > 0) {
        sampleTaskId = sanitizeIdentifier(hFiles[hFiles.length - 1].replace(/\.json$/, '')) || sampleTaskId;
      }
    }

    const dlqDir = path.join(meshDir, 'dlq');
    if (fs.existsSync(dlqDir)) {
      totalTasksCount += fs.readdirSync(dlqDir).filter(f => f.endsWith('.json')).length;
    }

    const julesLedgerPath = getLedgerPath();
    if (fs.existsSync(julesLedgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(julesLedgerPath, 'utf8'));
      if (Array.isArray(ledger.activeSessions)) {
        activeSessionsCount = ledger.activeSessions.length;
        if (ledger.activeSessions.length > 0 && ledger.activeSessions[0].id) {
          sampleSessionId = sanitizeIdentifier(ledger.activeSessions[0].id) || sampleSessionId;
        }
      }
    }
  } catch {}

  const rawRepoUrl = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url || '');
  const cleanRepoUrl = rawRepoUrl.replace(/^git\+/, '').replace(/\.git$/, '') || 'https://github.com/Suran123s/intercom-global';

  return {
    projectName: pkg.name || '@advance/intercom-global',
    projectVersion: pkg.version || '2.0.0',
    nodeMinVersion: pkg.engines?.node || '>=18.0.0',
    nodeVersion: process.version,
    repoUrl: cleanRepoUrl,
    cliCommand: 'intercom',
    cliCommandsCount,
    mcpServerName: 'intercom-global',
    mcpToolsCount: mcpToolNames.length,
    mcpToolsList: mcpToolNames.join(', '),
    testSuitesCount,
    testsCount: String(realTestsCount || testSuitesCount),
    harnesses,
    activePeers: Array.from(activePeersSet).filter(Boolean),
    activeTasksCount,
    totalTasksCount,
    sampleTaskId,
    activeSessionsCount,
    sampleSessionId,
    daemonPort: String(PORT || 4150),
    daemonUrl: `http://127.0.0.1:${PORT || 4150}`
  };
}

function loadCache(cachePath = DEFAULT_CACHE_PATH) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCacheAtomic(cachePath, snapshot) {
  if (!cachePath || !snapshot) return false;
  const dir = path.dirname(cachePath);
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const serialized = JSON.stringify(snapshot, null, 2);
    retryNtfsOperationSync(() => fs.writeFileSync(tmp, serialized, 'utf8'));
    retryNtfsOperationSync(() => fs.renameSync(tmp, cachePath));
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (fs.existsSync(tmp)) {
        retryNtfsOperationSync(() => fs.unlinkSync(tmp));
      }
    } catch {}
  }
}

function isCacheFresh(cache, ttlMs = DEFAULT_TTL_MS) {
  if (!cache || typeof cache.syncedAtEpochMs !== 'number') return false;
  const effectiveTtl = cache.offlineFallback ? Math.min(ttlMs, OFFLINE_COOLDOWN_MS) : ttlMs;
  return (Date.now() - cache.syncedAtEpochMs) < effectiveTtl;
}

/**
 * Synchronizes live internet registries and local runtime probes, purifies results,
 * ranks models, and persists an atomic TTL cache with graceful offline fallback.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function syncLiveRegistry(options = {}) {
  const cachePath = options.cachePath || process.env.INTERCOM_SCRAPE_CACHE || DEFAULT_CACHE_PATH;
  const ttlProvided = options.ttlMs !== undefined && options.ttlMs !== null && options.ttlMs !== '';
  const ttlParsed = ttlProvided ? Number(options.ttlMs) : NaN;
  const ttlMs = Number.isFinite(ttlParsed) && ttlParsed >= 0 ? ttlParsed : DEFAULT_TTL_MS;
  const timeoutProvided = options.timeoutMs !== undefined && options.timeoutMs !== null && options.timeoutMs !== '';
  const timeoutParsed = timeoutProvided ? Number(options.timeoutMs) : NaN;
  const timeoutMs = Number.isFinite(timeoutParsed) && timeoutParsed >= 0 ? timeoutParsed : DEFAULT_TIMEOUT_MS;
  const offline = Boolean(options.offline);
  const sources = Array.isArray(options.sources) ? options.sources : SCRAPE_SOURCES;

  const existingCache = loadCache(cachePath);
  if (!options.force && ttlMs > 0 && isCacheFresh(existingCache, ttlMs)) {
    const runtime = options.refreshRuntime === false && existingCache.runtime
      ? existingCache.runtime
      : probeLocalRuntime();
    return {
      ...existingCache,
      runtime,
      fromCache: true
    };
  }

  const rawDatasets = [];
  const sourceStatus = [];
  let npmLatestVersion = null;

  if (!offline) {
    const results = await Promise.allSettled(
      sources.map(async (src) => {
        const started = Date.now();
        const res = await fetchWithTimeout(src.url, {
          timeoutMs,
          fetchImpl: options.fetchImpl
        });
        return { src, res, durationMs: Date.now() - started };
      })
    );

    for (const settled of results) {
      if (settled.status !== 'fulfilled') {
        sourceStatus.push({ id: 'unknown', ok: false, error: settled.reason?.message || 'Fetch rejected' });
        continue;
      }
      const { src, res, durationMs } = settled.value;
      if (res.ok && res.json) {
        if (src.kind === 'npm') {
          const latest = sanitizeIdentifier(String(res.json['dist-tags']?.latest || res.json.version || ''));
          if (latest) npmLatestVersion = latest;
        } else {
          rawDatasets.push({ sourceId: src.id, data: res.json });
        }
        sourceStatus.push({ id: src.id, url: src.url, ok: true, durationMs });
      } else {
        sourceStatus.push({ id: src.id, url: src.url, ok: false, durationMs, error: res.error || 'No JSON payload' });
      }
    }
  }

  const onlineSucceeded = sourceStatus.some(s => s.ok);
  const completeSuccess = !offline
    && sources.length > 0
    && sourceStatus.length === sources.length
    && sourceStatus.every(s => s.ok);
  const hasCachedModels = Boolean(existingCache && Array.isArray(existingCache.models) && existingCache.models.length > 0);
  const usedCacheFallback = !completeSuccess && hasCachedModels;

  let purified;
  let offlineFallback = false;

  if (rawDatasets.length > 0) {
    const datasets = usedCacheFallback
      ? [{ sourceId: 'stale-cache', data: existingCache.models }, ...rawDatasets]
      : rawDatasets;
    purified = purifyScrapedData(datasets, { includeBaseline: true });
    offlineFallback = false;
  } else if (hasCachedModels) {
    offlineFallback = !onlineSucceeded;
    purified = {
      models: existingCache.models,
      freeModels: existingCache.freeModels || existingCache.models.filter(m => m.isFree),
      stats: existingCache.stats || {
        rawExtracted: 0,
        deduplicatedCount: existingCache.models.length,
        freeModelCount: (existingCache.freeModels || []).length,
        strippedInjections: 0
      }
    };
  } else {
    offlineFallback = !onlineSucceeded;
    purified = purifyScrapedData([], { includeBaseline: true });
  }

  const now = new Date();
  const runtime = probeLocalRuntime();
  if (npmLatestVersion && !runtime.latestNpmVersion) {
    runtime.latestNpmVersion = npmLatestVersion;
  }

  const flagshipExtras = purified.models.filter(
    m => m.id.toLowerCase().includes('claude') || m.id.toLowerCase().includes('gemini-3.6-flash')
  ).slice(0, 10);
  const topModels = purified.models.slice(0, 150);
  const topIds = new Set(topModels.map(m => m.id));
  for (const ex of flagshipExtras) {
    if (!topIds.has(ex.id)) topModels.push(ex);
  }

  const syncedAt = usedCacheFallback && existingCache.syncedAt
    ? existingCache.syncedAt
    : now.toISOString();
  const syncedAtEpochMs = usedCacheFallback && typeof existingCache.syncedAtEpochMs === 'number'
    ? existingCache.syncedAtEpochMs
    : now.getTime();

  const snapshot = {
    schemaVersion: 1,
    syncedAt,
    syncedAtEpochMs,
    ttlMs,
    offlineFallback,
    fromCache: false,
    sources: sourceStatus,
    models: topModels,
    freeModels: purified.freeModels.slice(0, 30),
    stats: purified.stats,
    runtime
  };

  const shouldPersist = options.writeCache !== false
    && (completeSuccess || onlineSucceeded || !existingCache);
  if (shouldPersist) {
    saveCacheAtomic(cachePath, snapshot);
  }

  return snapshot;
}

/**
 * Formats a clean Markdown table of purified models.
 * @param {object[]} models
 * @param {number} [limit=8]
 * @returns {string}
 */
function formatModelsMarkdownTable(models = [], limit = 8) {
  const rows = (Array.isArray(models) ? models : []).slice(0, limit);
  if (rows.length === 0) {
    return '| Model | Provider | Tier | Context | Reasoning | Score |\n|---|---|---|---|---|---|';
  }
  const header = '| Model | Provider | Tier | Context | Reasoning | Score |\n|---|---|---|---|---|---|';
  const body = rows.map((m) => {
    const tier = m.isFree ? 'FREE ($0.00)' : 'PAID';
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : 'N/A';
    const reasoning = m.reasoning ? 'Yes' : 'No';
    return `| \`${m.id}\` | ${m.provider} | ${tier} | ${ctx} | ${reasoning} | ${m.score} |`;
  });
  return [header, ...body].join('\n');
}

/**
 * Formats a Markdown table of supported harnesses and Zero-Qoder compliance.
 * @param {object[]} harnesses
 * @returns {string}
 */
function formatHarnessesMarkdownTable(harnesses = []) {
  const list = Array.isArray(harnesses) && harnesses.length > 0 ? harnesses : SUPPORTED_HARNESSES;
  const header = '| Harness | Status | Streaming | Sessions | Reasoning | Zero-Qoder Policy |\n|---|---|---|---|---|---|';
  const body = list.map((h) => {
    const status = h.barredAuto ? 'BARRED_AUTO' : (h.installed ? 'INSTALLED' : 'AVAILABLE');
    const policy = h.barredAuto ? 'Explicit Free-Tier Only' : 'Compliant (Auto-Eligible)';
    return `| \`${h.name}\` | ${status} | ${h.streaming ? 'Yes' : 'No'} | ${h.sessions ? 'Yes' : 'No'} | ${h.reasoning ? 'Yes' : 'No'} | ${policy} |`;
  });
  return [header, ...body].join('\n');
}

/**
 * Builds the canonical UPPER_SNAKE_CASE dynamic template variable dictionary aligned
 * with ex-delegate-mcp's live-scraper schema.
 * @param {object} [snapshot]
 * @param {object} [overrides]
 * @returns {Record<string, string>}
 */
function buildDynamicContext(snapshot = null, overrides = {}) {
  const snap = snapshot || loadCache() || {
    syncedAt: new Date().toISOString(),
    ttlMs: DEFAULT_TTL_MS,
    sources: SCRAPE_SOURCES.map(s => ({ id: s.id, url: s.url, ok: false })),
    models: purifyScrapedData([], { includeBaseline: true }).models,
    freeModels: purifyScrapedData([], { includeBaseline: true }).freeModels,
    runtime: probeLocalRuntime()
  };

  const runtime = snap.runtime || probeLocalRuntime();
  const models = Array.isArray(snap.models) && snap.models.length > 0
    ? snap.models
    : purifyScrapedData([], { includeBaseline: true }).models;
  const freeModels = Array.isArray(snap.freeModels) && snap.freeModels.length > 0
    ? snap.freeModels
    : models.filter(m => m.isFree);

  const nowIso = new Date().toISOString();
  const currentDate = nowIso.slice(0, 10);

  const defaultModel = freeModels.find(m => m.id === 'opencode/glm-5.3-flash-free')?.id
    || freeModels.find(m => m.provider === 'opencode' && m.id.includes('glm-5.3-flash'))?.id
    || freeModels.find(m => m.provider === 'opencode')?.id
    || freeModels[0]?.id
    || 'opencode/glm-5.3-flash-free';
  const defaultFallbackModel = freeModels.find(m => m.id === 'opencode/deepseek-v4.1-flash-free')?.id
    || freeModels.find(m => m.provider === 'opencode' && m.id !== defaultModel)?.id
    || freeModels.find(m => m.id !== defaultModel && m.id.toLowerCase().includes('deepseek'))?.id
    || freeModels.find(m => m.id !== defaultModel)?.id
    || 'opencode/deepseek-v4.1-flash-free';
  const defaultScaffoldModel = freeModels.find(m => m.id === 'minimax/MiniMax-M3.1-Flash-Preview')?.id
    || models.find(m => m.provider === 'minimax' && m.id.toLowerCase().includes('m3.1-flash'))?.id
    || freeModels.find(m => m.provider === 'minimax')?.id
    || 'minimax/MiniMax-M3.1-Flash-Preview';
  const defaultJulesModel = models.find(m => m.id.toLowerCase() === 'google/gemini-3.6-flash')?.id?.split('/').pop()
    || models.find(m => m.id.toLowerCase().endsWith('/gemini-3.6-flash'))?.id?.split('/').pop()
    || 'gemini-3.6-flash';
  const defaultClaudeModel = models.find(m => m.provider === 'anthropic' && m.id.toLowerCase().includes('claude-sonnet'))?.id
    || models.find(m => m.id.toLowerCase().includes('claude-sonnet'))?.id
    || 'anthropic/claude-sonnet-4.6';

  const harnesses = Array.isArray(runtime.harnesses) && runtime.harnesses.length > 0
    ? runtime.harnesses
    : SUPPORTED_HARNESSES.map(h => ({ ...h, installed: false }));

  const activeNonBarred = harnesses.filter(h => !h.barredAuto && h.installed).map(h => h.name);
  const activeHarnessesStr = activeNonBarred.length > 0
    ? activeNonBarred.join(', ')
    : 'opencode, claude, hermes, pi (Zero-Qoder enforced)';

  const topFreeSlice = freeModels.slice(0, 5);
  const sourcesStr = (Array.isArray(snap.sources) && snap.sources.length > 0
    ? snap.sources.map(s => s.url || s.id).filter(Boolean)
    : SCRAPE_SOURCES.map(s => s.url)
  ).join(', ');

  const activePeers = Array.isArray(runtime.activePeers) ? runtime.activePeers : [];

  const vars = {
    // 1) Temporal & Sync
    CURRENT_DATE: currentDate,
    CURRENT_ISO_TIMESTAMP: nowIso,
    LAST_SYNCED_AT: snap.syncedAt || nowIso,
    CACHE_TTL_MINUTES: String(Math.max(1, Math.round((snap.ttlMs || DEFAULT_TTL_MS) / 60000))),
    SCRAPE_SOURCES: sourcesStr,

    // 2) Project & Tooling Metadata
    PROJECT_NAME: runtime.projectName || '@advance/intercom-global',
    PROJECT_VERSION: runtime.projectVersion || '2.0.0',
    NODE_MIN_VERSION: runtime.nodeMinVersion || '>=18.0.0',
    NODE_VERSION: runtime.nodeVersion || process.version,
    REPO_URL: runtime.repoUrl || 'https://github.com/Suran123s/intercom-global',
    CLI_COMMAND: runtime.cliCommand || 'intercom',
    CLI_COMMANDS_COUNT: String(runtime.cliCommandsCount ?? discoverCliCommandsCount()),
    MCP_SERVER_NAME: runtime.mcpServerName || 'intercom-global',
    MCP_TOOLS_COUNT: String(runtime.mcpToolsCount ?? discoverMcpToolNames().length),
    MCP_TOOLS_LIST: runtime.mcpToolsList || '',
    TEST_SUITES_COUNT: String(runtime.testSuitesCount ?? countTestsAndSuites().suitesCount),
    TESTS_COUNT: String(runtime.testsCount ?? countTestsAndSuites().testsCount),

    // 3) Harnesses & Zero-Qoder Routing
    DEFAULT_HARNESS: 'opencode',
    ACTIVE_HARNESSES: activeHarnessesStr,
    SUPPORTED_HARNESSES: harnesses.map(h => h.name).join(', '),
    HARNESSES_COUNT: String(harnesses.length),
    HARNESSES_TABLE: formatHarnessesMarkdownTable(harnesses),
    FALLBACK_CHAIN: 'opencode -> claude -> hermes -> local-mesh (Zero-Qoder enforced)',
    QODER_ALLOWED_MODELS: QODER_ALLOWED_MODELS.join(', '),

    // 4) Models & Purified Live Benchmarks
    DEFAULT_MODEL: defaultModel,
    DEFAULT_FALLBACK_MODEL: defaultFallbackModel,
    DEFAULT_SCAFFOLD_MODEL: defaultScaffoldModel,
    DEFAULT_JULES_MODEL: defaultJulesModel,
    DEFAULT_CLAUDE_MODEL: defaultClaudeModel,
    DEFAULT_QODER_FREE_MODEL: 'qwen3.8-flash',
    TOP_FREE_MODELS: topFreeSlice.map(m => m.id).join(', '),
    TOP_FREE_MODELS_COUNT: String(snap.stats?.freeModelCount ?? freeModels.length),
    LIVE_MODELS_TABLE: formatModelsMarkdownTable(models, 8),
    LIVE_FREE_MODELS_TABLE: formatModelsMarkdownTable(freeModels, 8),
    LIVE_MODEL_COUNT: String(snap.stats?.deduplicatedCount ?? models.length),

    // 5) Runtime Tasks, Sessions & Mesh Peers
    ACTIVE_TASKS_COUNT: String(runtime.activeTasksCount ?? 0),
    TOTAL_TASKS_COUNT: String(runtime.totalTasksCount ?? 0),
    SAMPLE_TASK_ID: runtime.sampleTaskId || `task-${currentDate.replace(/-/g, '')}-001`,
    ACTIVE_SESSIONS_COUNT: String(runtime.activeSessionsCount ?? 0),
    SAMPLE_SESSION_ID: runtime.sampleSessionId || `sess-${currentDate.replace(/-/g, '')}-001`,
    ACTIVE_PEERS_COUNT: String(activePeers.length),
    ACTIVE_PEERS_LIST: activePeers.length > 0 ? activePeers.join(', ') : 'none (register with intercom register)',
    DAEMON_URL: runtime.daemonUrl || `http://127.0.0.1:${PORT || 4150}`,
    DAEMON_PORT: String(runtime.daemonPort || PORT || 4150)
  };

  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined && v !== null) {
      vars[k] = String(v);
    }
  }
  return vars;
}

/**
 * Hydrates `{{UPPER_SNAKE_CASE}}` template tokens in Markdown content while preserving
 * GitHub Actions `${{ ... }}` expressions and unknown tokens untouched.
 * @param {string} content
 * @param {Record<string, string>|object} [context]
 * @returns {string}
 */
function hydrateMarkdown(content, context = null) {
  if (typeof content !== 'string') return '';
  const vars = context && typeof context === 'object' && Object.prototype.hasOwnProperty.call(context, 'CURRENT_DATE')
    ? context
    : buildDynamicContext(null, context || {});

  return content.replace(/(?<!\$)\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return match;
  });
}

/**
 * Schedules a non-blocking background scrape if cache is missing or stale.
 * Strictly emits zero stdout so MCP stdio JSON-RPC and CLI JSON outputs stay clean.
 * @param {object} [options] { mode?: 'subprocess'|'in-process', cachePath?: string, ttlMs?: number }
 * @returns {{ scheduled: boolean, reason: string }}
 */
function scheduleBackgroundSync(options = {}) {
  const disabled = process.env.INTERCOM_DISABLE_LIVE_SYNC === '1' || process.env.INTERCOM_DISABLE_LIVE_SYNC === 'true';
  if (disabled) {
    return { scheduled: false, reason: 'disabled-by-env' };
  }

  const cachePath = options.cachePath || process.env.INTERCOM_SCRAPE_CACHE || DEFAULT_CACHE_PATH;
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const existing = loadCache(cachePath);

  if (isCacheFresh(existing, ttlMs)) {
    return { scheduled: false, reason: 'cache-fresh' };
  }

  const inTestEnv = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';
  if (inTestEnv && !options.fetchImpl) {
    return { scheduled: false, reason: 'disabled-in-test' };
  }

  const mode = options.mode || (options.fetchImpl ? 'in-process' : 'subprocess');
  if (mode === 'in-process') {
    setImmediate(() => {
      syncLiveRegistry({ ...options, cachePath, ttlMs, writeCache: options.writeCache !== false }).catch(() => {});
    });
    return { scheduled: true, reason: 'in-process' };
  }

  const scriptPath = path.join(ROOT_DIR, 'scripts', 'live-scrape-sync.js');
  if (!fs.existsSync(scriptPath)) {
    return { scheduled: false, reason: 'sync-script-missing' };
  }

  try {
    const child = spawn(process.execPath, [scriptPath, '--quiet'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        INTERCOM_SCRAPE_CACHE: cachePath
      }
    });
    if (typeof child.unref === 'function') {
      child.unref();
    }
    return { scheduled: true, reason: 'subprocess' };
  } catch (err) {
    return { scheduled: false, reason: err.message };
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_CACHE_PATH,
  SCRAPE_SOURCES,
  QODER_ALLOWED_MODELS,
  SUPPORTED_HARNESSES,
  CURATED_BASELINE_MODELS,
  stripControlAndInvisible,
  decodeHtmlEntities,
  stripTrackingParamsFromText,
  stripPromptInjections,
  purifyContent,
  sanitizeIdentifier,
  isQoderFreeModel,
  enforceZeroQoderPolicy,
  scoreModel,
  normalizeModelRecord,
  purifyScrapedData,
  fetchWithTimeout,
  scrapeUrl,
  probeLocalRuntime,
  loadCache,
  saveCacheAtomic,
  isCacheFresh,
  syncLiveRegistry,
  formatModelsMarkdownTable,
  formatHarnessesMarkdownTable,
  buildDynamicContext,
  hydrateMarkdown,
  scheduleBackgroundSync
};
