#!/usr/bin/env node
/**
 * bin/intercom-tui.js - Intercom Global Terminal UI (Wave 6 Minimalist OpenCode Parity)
 *
 * Clean OpenCode-inspired minimalist UX with zero fixed left-sidebar clutter:
 *   Row 1 (Full Top Bar) : Clickable Top-Left Sub-Tabs ([ ✦ Home ], [ @peer × ], [ #ch × ], [ + New ])
 *                          + Top-Right [ ☰ Menu ] toggle for the collapsible RIGHT sidebar
 *   Main Workspace       : Centered Composer on Home/Empty view; high-contrast speech bubbles
 *                          above centered-width composer on active threads
 *   Dropdowns            : Real Target Selector Dropdown (To: [ @peer ▾ ]) + Live `/` Slash-Command Menu
 *   Collapsible Sidebar  : Hidden by default (rightSidebarOpen = false); opens on the RIGHT side
 *   Lower Corner         : Compact stats (Peers: X · Unread: Y · Ch: Z · DLQ: W), toggleable in Settings
 *   Pure Messaging       : 100% pure messaging focus — zero task runners or execution flags
 *
 * Usage:
 *   intercom tui
 *   node bin/intercom-tui.js
 */

"use strict";

const fs       = require("fs");
const path     = require("path");
const { PassThrough } = require("stream");
const blessed  = require("blessed");
const chokidar = require("chokidar");

const {
  listActiveMailboxes,
  clearInbox,
  sendChannelMessage,
  listChannels,
  writeMessage,
  readInboxSync,
  updateDiscreteEnvelopeSync,
  checkAndMarkRead,
  HeartbeatRegistry,
  validateAgentName
} = require("../src/core/mesh");
const { MessageEnvelope } = require("../src/core/message");
const { listActiveAgents } = require("../src/core/registry");
const { diagnoseMesh } = require("../src/controllers/autowake");
const { getDlq }       = require("../src/core/dlq");
const { getMeshDir, getPort, MESH_DIR, PORT } = require("../src/config");

// ─────────────────────────────────────────────────────────────────
//  ANSI colour constants & Theme Palettes (deep-dark charcoal #0d1117 + light slate)
// ─────────────────────────────────────────────────────────────────
const A = {
  reset:        "\x1b[0m",
  bold:         "\x1b[1m",
  dim:          "\x1b[2m",
  italic:       "\x1b[3m",
  underline:    "\x1b[4m",
  inverse:      "\x1b[7m",
  // Foreground
  black:        "\x1b[30m",
  white:        "\x1b[97m",
  softWhite:    "\x1b[37m",
  gray:         "\x1b[38;5;244m",
  darkGray:     "\x1b[38;5;239m",
  cyan:         "\x1b[96m",
  blue:         "\x1b[94m",
  green:        "\x1b[92m",
  yellow:       "\x1b[93m",
  red:          "\x1b[91m",
  magenta:      "\x1b[95m",
  // Background — deep charcoal palette (#0d1117 / slate)
  bgCanvas:     "\x1b[48;5;234m",   // #0d1117 deep charcoal main canvas
  bgSidebar:    "\x1b[48;5;233m",   // slightly deeper collapsible right sidebar
  bgSelected:   "\x1b[48;5;237m",   // subtle selection highlight / pill
  bgActiveNav:  "\x1b[48;5;24m",    // rich deep blue active pill
  bgHeader:     "\x1b[48;5;233m",   // top bar strip
  bgFooter:     "\x1b[48;5;233m",   // bottom bar strip
  bgInput:      "\x1b[48;5;235m",   // compose input card
  bgDropdown:   "\x1b[48;5;235m",   // floating dropdown surface
  bgBubble:     "\x1b[48;5;235m",   // message bubble body
  bgBubbleSelf: "\x1b[48;5;236m",   // self message bubble body
  bgCursor:     "\x1b[48;5;39m"     // 256-color cyan block cursor
};

const LIGHT_THEME = Object.freeze({
  bgCanvas:     "\x1b[48;5;254m",
  bgSidebar:    "\x1b[48;5;252m",
  bgSelected:   "\x1b[48;5;250m",
  bgActiveNav:  "\x1b[48;5;32m",
  bgHeader:     "\x1b[48;5;252m",
  bgFooter:     "\x1b[48;5;252m",
  bgInput:      "\x1b[48;5;255m",
  bgDropdown:   "\x1b[48;5;255m",
  bgBubble:     "\x1b[48;5;255m",
  bgBubbleSelf: "\x1b[48;5;195m",
  bgCursor:     "\x1b[48;5;24m",
  fgPrimary:    "\x1b[38;5;234m",
  fgSubtle:     "\x1b[38;5;236m",
  fgMuted:      "\x1b[38;5;240m",
  fgDimBorder:  "\x1b[38;5;246m",
  fgAccent:     "\x1b[38;5;25m",
  fgChannel:    "\x1b[38;5;127m",
  fgSelf:       "\x1b[38;5;28m",
  fgWarn:       "\x1b[38;5;130m",
  fgDanger:     "\x1b[38;5;160m",
  fgOnActive:   A.white,
  fgCursor:     A.white
});

const DARK_THEME = Object.freeze({
  bgCanvas:     A.bgCanvas,
  bgSidebar:    A.bgSidebar,
  bgSelected:   A.bgSelected,
  bgActiveNav:  A.bgActiveNav,
  bgHeader:     A.bgHeader,
  bgFooter:     A.bgFooter,
  bgInput:      A.bgInput,
  bgDropdown:   A.bgDropdown,
  bgBubble:     A.bgBubble,
  bgBubbleSelf: A.bgBubbleSelf,
  bgCursor:     A.bgCursor,
  fgPrimary:    A.white,
  fgSubtle:     A.softWhite,
  fgMuted:      A.gray,
  fgDimBorder:  A.darkGray,
  fgAccent:     A.cyan,
  fgChannel:    A.magenta,
  fgSelf:       A.green,
  fgWarn:       A.yellow,
  fgDanger:     A.red,
  fgOnActive:   A.white,
  fgCursor:     A.black
});

// Box drawing (rounded OpenCode style)
const B = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│", vl: "├", vr: "┤",
  tt: "┬", bt: "┴", cross: "┼"
};

// ─────────────────────────────────────────────────────────────────
//  Navigation, Slash Commands & Settings Catalogs
// ─────────────────────────────────────────────────────────────────
const NAV_TABS = ["Home", "Inbox", "Channels", "Peers", "Info", "Settings", "Help"];

const KNOWN_DEFAULT_PEERS = ["antigravity", "opencode", "jules", "sentinel", "coordinator"];
const KNOWN_DEFAULT_CHANNELS = ["general", "alerts", "handoffs"];

const SLASH_COMMANDS = Object.freeze([
  { cmd: "/msg",      syntax: "/msg <peer> <text>",       desc: "Message an agent peer directly",                  hasArgs: true },
  { cmd: "/channel",  syntax: "/channel <name> [text]",   desc: "Open or broadcast to a topic channel",            hasArgs: true },
  { cmd: "/peers",    syntax: "/peers",                   desc: "Open active Peer Mailboxes directory",            hasArgs: false },
  { cmd: "/info",     syntax: "/info",                    desc: "Open Intercom Mesh Health & System Info",         hasArgs: false },
  { cmd: "/settings", syntax: "/settings",                desc: "Toggle UI/UX & Telemetry settings",               hasArgs: false },
  { cmd: "/refresh",  syntax: "/refresh",                 desc: "Refresh peers, channels & mesh health manually",  hasArgs: false },
  { cmd: "/clear",    syntax: "/clear",                   desc: "Clear current inbox or prompt",                   hasArgs: false },
  { cmd: "/menu",     syntax: "/menu",                    desc: "Toggle right-side sidebar menu",                  hasArgs: false },
  { cmd: "/new",      syntax: "/new",                     desc: "Open new conversation sub-tab",                   hasArgs: false },
  { cmd: "/activity", syntax: "/activity",                desc: "Open Mesh Activity Stream",                       hasArgs: false },
  { cmd: "/zen",      syntax: "/zen",                     desc: "Toggle Zen / Focus Mode",                         hasArgs: false },
  { cmd: "/read",     syntax: "/read",                    desc: "Mark current peer inbox messages as read",        hasArgs: false },
  { cmd: "/help",     syntax: "/help",                    desc: "Show Intercom shortcuts & slash commands",        hasArgs: false }
]);

const SETTINGS_OPTIONS = Object.freeze([
  { key: "showCornerStats",    label: "Corner Stats",    desc: "Show compact Peers · Unread · Ch · DLQ stats in lower corner" },
  { key: "readReceipts",       label: "Read Receipts",   desc: "Display [UNREAD] / [READ] badges on inbox messages" },
  { key: "showTimestamps",     label: "Timestamps",      desc: "Show HH:MM:SS timestamps on message bubbles" },
  { key: "darkTheme",          label: "Dark Theme",      desc: "Deep dark charcoal canvas (#0d1117 / 48;5;234m)" },
  { key: "sidebarDefaultOpen", label: "Sidebar Default", desc: "Start Intercom with the right-side sidebar expanded" }
]);

// ─────────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────────
let settings = {
  showCornerStats:    true,
  readReceipts:       true,
  showTimestamps:     true,
  darkTheme:          true,
  sidebarDefaultOpen: false
};
let selectedSettingIndex = 0;

let activeNav          = 0;          // 0=Home, 1=Inbox, 2=Channels, 3=Peers, 4=Info, 5=Settings, 6=Help, 7=Activity
let lastNonHelpNav     = 0;          // Tracks previous non-Help view for Help [ × Close ]
let rightSidebarOpen   = Boolean(settings.sidebarDefaultOpen);
let zenMode            = false;      // Focus/Zen mode toggled via z/Z (or Ctrl+Z)
let selectedType       = "peer";     // "peer" | "channel"
let selectedAgent      = "antigravity";
let selectedChannel    = "general";
let agentList          = [...KNOWN_DEFAULT_PEERS];
let channelList        = [...KNOWN_DEFAULT_CHANNELS];
let agentMetaMap       = new Map();  // name -> { total, unread, online }
let channelMetaMap     = new Map();  // name -> { total }
let onlinePeersSet     = new Set();  // lowercase active/heartbeat peer names
let threadCache        = new Map();  // key ("peer:<name>"|"channel:<name>") -> { messages, mtimeMs, loadedAt }
let agentIdx           = 0;
let channelIdx         = 0;

let subTabs = [
  { id: "home",             kind: "home",    target: null,          label: "✦ Home",       closable: false },
  { id: "peer:antigravity", kind: "peer",    target: "antigravity", label: "@antigravity", closable: true },
  { id: "channel:general",  kind: "channel", target: "general",     label: "#general",     closable: true }
];
let activeSubTabIndex         = 0;
let subTabScrollOffset        = 0;
let ensureActiveSubTabVisible = false;

let composerBuffer     = "";
let composerCursor     = 0;
let composerFocused    = true;
let composerFocusZone  = "input";    // "input" | "target" | "send" | "clear"

let targetDropdownOpen  = false;
let targetDropdownIndex = 0;

let slashSelectedIndex = 0;
let slashMenuDismissed = false;

let scrollOffset       = 0;
let selectedMessageIndex = -1;
let peerFilterActive   = false;
let peerFilterQuery    = "";
let peerFilterCursor   = 0;
let lastStatusNotice   = "Pure Mesh Messaging · Press / for commands";
let meshStats          = { peers: KNOWN_DEFAULT_PEERS.length, unread: 0, channels: KNOWN_DEFAULT_CHANNELS.length, dlq: 0 };
let meshInfoCache      = { services: {}, mailboxes: [], channels: [], dlq: [], updatedAt: null };
const activityLog      = [];

let watcher            = null;
let watchedInboxAgent  = null;
let pollInterval       = null;
let watchDebounceTimer = null;
let loadListsInFlight  = null;
let refreshInFlight    = null;
let refreshQueued      = false;

function getSelfIdentity() {
  const envAgent = String(process.env.INTERCOM_AGENT || process.env.USER || "").trim();
  return envAgent || "operator";
}

function isPeerOnline(name) {
  const key = String(name || "").toLowerCase();
  if (!key) return false;
  const meta = agentMetaMap.get(name) || agentMetaMap.get(key);
  if (meta && typeof meta.online === "boolean") return meta.online;
  return onlinePeersSet.has(key);
}

function formatPeerStatusBadge(name, theme = getTheme()) {
  const online = isPeerOnline(name);
  const dot = online ? `${theme.fgSelf}●${A.reset}` : `${theme.fgMuted}○${A.reset}`;
  const label = online ? `${theme.fgSelf}● Online` : `${theme.fgMuted}○ Offline`;
  return { online, dot, label };
}

function logActivity(text) {
  const ts = new Date().toLocaleTimeString();
  activityLog.unshift(`[${ts}] ${sanitizeTerminalText(text)}`);
  if (activityLog.length > 50) activityLog.pop();
}

function getTheme() {
  return settings.darkTheme !== false ? DARK_THEME : LIGHT_THEME;
}

function getCanvasBg() {
  return getTheme().bgCanvas;
}

// ─────────────────────────────────────────────────────────────────
//  Terminal Escape Sanitization, Grapheme Width & ANSI-safe Clipping
// ─────────────────────────────────────────────────────────────────
const ANSI_TOKEN_REGEX = /(\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*(?:\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|\x9b[0-?]*[ -/]*[@-~])/g;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sanitizeTerminalText(str, options = {}) {
  const allowNewlines = Boolean(options && options.allowNewlines);
  let s = String(str ?? "");
  // Strip OSC (ESC ] ... BEL/ST) and C1 OSC (0x9d ... ST)
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "");
  s = s.replace(/\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, "");
  // Strip DCS/SOS/PM/APC strings (ESC P/X/^/_ ... ST) and C1 equivalents
  s = s.replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\|$)/g, "");
  s = s.replace(/[\x90\x98\x9e\x9f][^\x1b\x9c]*(?:\x1b\\|\x9c|$)/g, "");
  // Strip CSI sequences (including DEC private modes) and C1 CSI (0x9b)
  s = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, "");
  s = s.replace(/\x9b[0-?]*[ -/]*[@-~]?/g, "");
  // Strip remaining 2-byte ESC sequences or lone ESC
  s = s.replace(/\x1b[\s\S]?/g, "");
  // Normalize line breaks before control stripping
  s = s.replace(/\r\n?/g, "\n");
  if (allowNewlines) {
    s = s.replace(/\t/g, "  ");
    // Strip C0 (except \n), DEL, and C1 (0x80-0x9f)
    s = s.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
  } else {
    s = s.replace(/[\n\t]+/g, " ");
    s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  }
  return s;
}

function stripAnsi(str) {
  return String(str || "")
    .replace(ANSI_TOKEN_REGEX, "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function charDisplayWidth(code) {
  if (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x00ad ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0xfeff ||
    (code >= 0x1f3fb && code <= 0x1f3ff) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1fbff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function graphemeDisplayWidth(seg) {
  if (!seg) return 0;
  if (seg.includes("\u200d")) return 2;
  let baseW = 0;
  let firstCp = 0;
  for (const ch of seg) {
    const cp = ch.codePointAt(0);
    if (baseW === 0) {
      const w = charDisplayWidth(cp);
      if (w > 0) {
        baseW = w;
        firstCp = cp;
      }
    }
  }
  if (baseW === 1 && seg.includes("\ufe0f") && firstCp >= 0x2300) {
    return 2;
  }
  return baseW;
}

function splitGraphemes(str) {
  const s = String(str || "");
  if (!s) return [];
  const out = [];
  for (const part of graphemeSegmenter.segment(s)) {
    out.push({
      segment: part.segment,
      index: part.index,
      width: graphemeDisplayWidth(part.segment)
    });
  }
  return out;
}

function stringWidth(str) {
  const plain = stripAnsi(str);
  if (!plain) return 0;
  if (/^[\x20-\x7e]*$/.test(plain)) return plain.length;
  let w = 0;
  for (const part of graphemeSegmenter.segment(plain)) {
    w += graphemeDisplayWidth(part.segment);
  }
  return w;
}

function clipAnsi(str, maxCols) {
  if (!str || maxCols <= 0) return "";
  const s = String(str);
  if (stringWidth(s) <= maxCols) return s;

  let out = "";
  let vis = 0;
  let hasStyle = false;
  let lastIdx = 0;
  ANSI_TOKEN_REGEX.lastIndex = 0;
  let m;

  const consumePlain = (plain) => {
    for (const part of graphemeSegmenter.segment(plain)) {
      const w = graphemeDisplayWidth(part.segment);
      if (vis + w > maxCols) return false;
      out += part.segment;
      vis += w;
    }
    return true;
  };

  while ((m = ANSI_TOKEN_REGEX.exec(s)) !== null) {
    if (m.index > lastIdx) {
      if (!consumePlain(s.slice(lastIdx, m.index))) {
        return hasStyle ? `${out}${A.reset}` : out;
      }
    }
    out += m[0];
    hasStyle = m[0] !== A.reset && m[0] !== "\x1b[m";
    lastIdx = ANSI_TOKEN_REGEX.lastIndex;
  }

  if (lastIdx < s.length) {
    if (!consumePlain(s.slice(lastIdx))) {
      return hasStyle ? `${out}${A.reset}` : out;
    }
  }
  return hasStyle ? `${out}${A.reset}` : out;
}

function padEnd(str, targetLen, char = " ") {
  const currentW = stringWidth(str);
  const diff = targetLen - currentW;
  return str + (diff > 0 ? char.repeat(diff) : "");
}

function restoreBgAfterReset(str, bg) {
  if (!bg) return str;
  return String(str).replace(/\x1b\[0?m/g, `${A.reset}${bg}`);
}

function fitToWidth(str, width, bg = "") {
  const targetW = Math.max(0, width || 0);
  if (targetW === 0) return "";
  const s = String(str || "");
  const vLen = stringWidth(s);
  if (vLen === targetW) {
    const body = bg ? restoreBgAfterReset(s, bg) : s;
    return bg ? `${bg}${body}${A.reset}` : body;
  }
  if (vLen < targetW) {
    const body = bg ? restoreBgAfterReset(s, bg) : s;
    const padded = body + " ".repeat(targetW - vLen);
    return bg ? `${bg}${padded}${A.reset}` : padded;
  }
  const clipped = clipAnsi(s, targetW);
  const clippedW = stringWidth(clipped);
  const body = bg ? restoreBgAfterReset(clipped, bg) : clipped;
  const tail = clippedW < targetW ? " ".repeat(targetW - clippedW) : "";
  return bg ? `${bg}${body}${tail}${A.reset}` : `${body}${tail}`;
}

function wrapText(text, maxW) {
  const safeW = Math.max(8, maxW || 40);
  if (!text) return [""];
  const paragraphs = String(text).split(/\r?\n/);
  const lines = [];
  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let cur = "";
    let curW = 0;
    for (const w of words) {
      if (!w) continue;
      const wW = stringWidth(w);
      if (!cur) {
        if (wW <= safeW) {
          cur = w;
          curW = wW;
        } else {
          // O(W) grapheme-aware split for overly long tokens
          let chunk = "";
          let chunkW = 0;
          for (const part of graphemeSegmenter.segment(w)) {
            const gW = graphemeDisplayWidth(part.segment);
            if (chunkW + gW > safeW && chunk) {
              lines.push(chunk);
              chunk = part.segment;
              chunkW = gW;
            } else {
              chunk += part.segment;
              chunkW += gW;
            }
          }
          cur = chunk;
          curW = chunkW;
        }
      } else if (curW + 1 + wW <= safeW) {
        cur += " " + w;
        curW += 1 + wW;
      } else {
        lines.push(cur);
        if (wW <= safeW) {
          cur = w;
          curW = wW;
        } else {
          let chunk = "";
          let chunkW = 0;
          for (const part of graphemeSegmenter.segment(w)) {
            const gW = graphemeDisplayWidth(part.segment);
            if (chunkW + gW > safeW && chunk) {
              lines.push(chunk);
              chunk = part.segment;
              chunkW = gW;
            } else {
              chunk += part.segment;
              chunkW += gW;
            }
          }
          cur = chunk;
          curW = chunkW;
        }
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.length > 0 ? lines : [""];
}

// ─────────────────────────────────────────────────────────────────
//  Readline / Emacs Line Editing & Display-Width Cursor Rendering
// ─────────────────────────────────────────────────────────────────
function findBackwardWord(text, pos) {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

function findForwardWord(text, pos) {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

function prevGraphemeBoundary(text, pos) {
  let prev = 0;
  for (const part of graphemeSegmenter.segment(text)) {
    if (part.index >= pos) break;
    prev = part.index;
  }
  return prev;
}

function nextGraphemeBoundary(text, pos) {
  for (const part of graphemeSegmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (end > pos) return end;
  }
  return text.length;
}

function applyReadlineKey(bufState, str, key = {}) {
  const val = String(bufState.value || "");
  if (bufState.cursor === undefined || bufState.cursor > val.length) {
    bufState.cursor = val.length;
  }
  const pos = Math.max(0, Math.min(bufState.cursor, val.length));

  // Ctrl+A / Home
  if (key.name === "home" || (key.ctrl && key.name === "a") || str === "\x01") {
    bufState.cursor = 0;
    return true;
  }
  // Ctrl+E / End
  if (key.name === "end" || (key.ctrl && key.name === "e") || str === "\x05") {
    bufState.cursor = val.length;
    return true;
  }
  // Ctrl+K (kill to end)
  if ((key.ctrl && key.name === "k") || str === "\x0b") {
    bufState.value = val.slice(0, pos);
    return true;
  }
  // Ctrl+U (kill to start)
  if ((key.ctrl && key.name === "u") || str === "\x15") {
    bufState.value = val.slice(pos);
    bufState.cursor = 0;
    return true;
  }
  // Ctrl+W (delete previous word)
  if ((key.ctrl && key.name === "w") || str === "\x17") {
    const bIdx = findBackwardWord(val, pos);
    bufState.value = val.slice(0, bIdx) + val.slice(pos);
    bufState.cursor = bIdx;
    return true;
  }
  // Alt+B / Ctrl+Left (backward word)
  if ((key.meta && (str === "b" || str === "B" || key.name === "b")) || (key.ctrl && key.name === "left") || str === "\x1bb") {
    bufState.cursor = findBackwardWord(val, pos);
    return true;
  }
  // Alt+F / Ctrl+Right (forward word)
  if ((key.meta && (str === "f" || str === "F" || key.name === "f")) || (key.ctrl && key.name === "right") || str === "\x1bf") {
    bufState.cursor = findForwardWord(val, pos);
    return true;
  }
  // Alt+D / Ctrl+Delete (forward word delete)
  if ((key.meta && (str === "d" || str === "D" || key.name === "d")) || (key.ctrl && key.name === "delete") || str === "\x1bd") {
    const fIdx = findForwardWord(val, pos);
    bufState.value = val.slice(0, pos) + val.slice(fIdx);
    return true;
  }
  // Left / Right / Delete / Backspace (grapheme-safe)
  if (key.name === "left") {
    bufState.cursor = pos > 0 ? prevGraphemeBoundary(val, pos) : 0;
    return true;
  }
  if (key.name === "right") {
    bufState.cursor = pos < val.length ? nextGraphemeBoundary(val, pos) : val.length;
    return true;
  }
  if (key.name === "delete") {
    if (pos < val.length) {
      const next = nextGraphemeBoundary(val, pos);
      bufState.value = val.slice(0, pos) + val.slice(next);
    }
    return true;
  }
  if (key.name === "backspace") {
    if (pos > 0) {
      const prev = prevGraphemeBoundary(val, pos);
      bufState.value = val.slice(0, prev) + val.slice(pos);
      bufState.cursor = prev;
    }
    return true;
  }

  // Printable characters
  if (str && !key.ctrl && !key.meta && !str.startsWith("\x1b")) {
    const clean = sanitizeTerminalText(str);
    if (clean) {
      bufState.value = val.slice(0, pos) + clean + val.slice(pos);
      bufState.cursor = pos + clean.length;
      return true;
    }
  }
  return false;
}

function renderCursorText(text, cursorPos, maxLen, isActive, placeholder = "") {
  const theme = getTheme();
  const safeMax = Math.max(1, maxLen || 1);
  const val = sanitizeTerminalText(text);
  const safePh = sanitizeTerminalText(placeholder);

  if (!val && !isActive) {
    return `${theme.fgMuted}${clipAnsi(safePh, safeMax)}${A.reset}`;
  }
  if (!val && isActive) {
    const ph = clipAnsi(safePh, Math.max(0, safeMax - 1));
    return `${theme.bgCursor}${theme.fgCursor} ${A.reset}${theme.bgInput}${theme.fgMuted}${ph}${A.reset}`;
  }

  const gs = splitGraphemes(val);
  if (!isActive) {
    const totalW = gs.reduce((acc, g) => acc + g.width, 0);
    if (totalW <= safeMax) {
      return `${theme.fgPrimary}${val}${A.reset}`;
    }
    const tailBudget = Math.max(0, safeMax - 3);
    let usedW = 0;
    let startIdx = gs.length;
    while (startIdx > 0 && usedW + gs[startIdx - 1].width <= tailBudget) {
      startIdx--;
      usedW += gs[startIdx].width;
    }
    const tail = gs.slice(startIdx).map((g) => g.segment).join("");
    return `${theme.fgPrimary}...${tail}${A.reset}`;
  }

  const pos = Math.max(0, Math.min(cursorPos ?? val.length, val.length));
  let gCursor = gs.length;
  for (let i = 0; i < gs.length; i++) {
    if (gs[i].index >= pos) {
      gCursor = i;
      break;
    }
  }

  const cursorG = gCursor < gs.length ? gs[gCursor] : { segment: " ", width: 1 };
  const cursorW = Math.max(1, cursorG.width);

  // Scroll left bound so cursor cell + preceding context fit within safeMax display columns
  let startG = 0;
  let prefixW = 0;
  for (let i = 0; i < gCursor; i++) prefixW += gs[i].width;
  while (startG < gCursor && prefixW + cursorW > safeMax) {
    prefixW -= gs[startG].width;
    startG++;
  }

  // Fill remaining display columns after cursor
  let usedW = prefixW + cursorW;
  let endG = gCursor + 1;
  while (endG < gs.length && usedW + gs[endG].width <= safeMax) {
    usedW += gs[endG].width;
    endG++;
  }

  const before = gs.slice(startG, gCursor).map((g) => g.segment).join("");
  const atCursor = cursorG.segment;
  const after = gCursor < gs.length ? gs.slice(gCursor + 1, endG).map((g) => g.segment).join("") : "";
  return `${theme.fgPrimary}${before}${A.reset}${theme.bgCursor}${theme.fgCursor}${atCursor}${A.reset}${theme.bgInput}${theme.fgPrimary}${after}${A.reset}`;
}

// ─────────────────────────────────────────────────────────────────
//  Hitbox registry (populated during each render)
// ─────────────────────────────────────────────────────────────────
let hitboxes = []; // { row, endRow, startCol, endCol, action, payload, z }

function registerHitbox(row, startCol, endCol, action, payload = {}, endRow = row, z = 0) {
  if (endCol < startCol) return;
  hitboxes.push({ row, endRow, startCol, endCol, action, payload, z });
}

function hitTest(row, col) {
  // Scan backwards so top-most overlays (highest z, then latest registered) match first
  let best = null;
  let bestZ = -Infinity;
  for (let i = hitboxes.length - 1; i >= 0; i--) {
    const hb = hitboxes[i];
    const maxRow = hb.endRow || hb.row;
    if (row >= hb.row && row <= maxRow && col >= hb.startCol && col <= hb.endCol) {
      const z = hb.z || 0;
      if (z > bestZ) {
        best = hb;
        bestZ = z;
      }
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────
//  Screen setup (blessed canvas with full SGR extended mouse)
// ─────────────────────────────────────────────────────────────────
const isHeadlessTest = Boolean(
  process.env.NODE_TEST_CONTEXT ||
  process.argv.some((a) => a.includes(".test.")) ||
  (!process.stdout.isTTY && require.main !== module && !process.argv.includes("tui"))
);

const screen = blessed.screen({
  smartCSR:    true,
  title:       "Intercom Global · Pure Mesh Messaging",
  dockBorders: false,
  fullUnicode: true,
  terminal:    "xterm-256color",
  output:      isHeadlessTest ? new PassThrough() : process.stdout
});

function enableMouseTracking() {
  if (isHeadlessTest) return;
  process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  if (screen.program && typeof screen.program.setMouse === "function") {
    try {
      screen.program.setMouse({ sgrMouse: true, vt200Mouse: true, cellMotion: true, allMotion: true }, true);
    } catch {}
  }
}

function disableMouseTracking() {
  if (isHeadlessTest) return;
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l");
}

if (!isHeadlessTest) {
  enableMouseTracking();
}

function destroyScreen() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = null;
  }
  if (watcher) {
    try { watcher.close(); } catch {}
    watcher = null;
  }
  disableMouseTracking();
  try { screen.destroy(); } catch {}
  try { if (process.stdin.pause) process.stdin.pause(); } catch {}
  try { if (process.stdin.unref) process.stdin.unref(); } catch {}
}

function cleanExit() {
  destroyScreen();
  if (!isHeadlessTest) {
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────
//  LAYOUT WIDGETS (Preserved exports + Clean Full-Screen Canvas)
// ─────────────────────────────────────────────────────────────────
const SIDEBAR_W = 26;

const mainCanvasBox = blessed.box({
  top: 0, left: 0, width: "100%", height: "100%",
  tags: false,
  mouse: true,
  keys: true,
  style: { bg: 234 }
});

// Preserved widget exports for backward compatibility with headless tests
const sidebarBox = blessed.box({
  top: 1, right: 0, width: SIDEBAR_W, bottom: 1,
  tags: false,
  hidden: true,
  style: { bg: 233 },
  mouse: true
});

const contentBox = blessed.box({
  top: 1, left: 0, right: 0, bottom: 1,
  tags: false,
  hidden: true,
  scrollable: true,
  mouse: true,
  style: { bg: 234 }
});

const composeInput = {
  _label: "",
  getValue: () => composerBuffer,
  setValue: (v) => {
    composerBuffer = String(v || "");
    composerCursor = composerBuffer.length;
    slashMenuDismissed = false;
  },
  clearValue: () => {
    composerBuffer = "";
    composerCursor = 0;
    slashMenuDismissed = false;
  },
  focus: () => {
    composerFocused = true;
  },
  setLabel: (lbl) => {
    composeInput._label = String(lbl || "");
  }
};

screen.append(mainCanvasBox);
screen.append(sidebarBox);
screen.append(contentBox);

// ─────────────────────────────────────────────────────────────────
//  SUB-TAB & DROPDOWN HELPERS
// ─────────────────────────────────────────────────────────────────
function getActiveSubTab() {
  return subTabs[activeSubTabIndex] || subTabs[0];
}

function syncComposerFocusForNav(navIndex) {
  composerFocused = navIndex <= 2;
  if (composerFocused) composerFocusZone = "input";
}

function getPeerUnreadCount(name) {
  if (!name) return 0;
  const lower = String(name).toLowerCase();
  let meta = agentMetaMap.get(name);
  if (!meta) {
    for (const [k, v] of agentMetaMap.entries()) {
      if (String(k).toLowerCase() === lower) {
        meta = v;
        break;
      }
    }
  }
  if (meta && typeof meta.unread === "number") return Math.max(0, meta.unread);
  const cached = threadCache.get(`peer:${name}`);
  if (cached && Array.isArray(cached.messages)) {
    const cacheUnread = cached.messages.filter((m) => !(m.read || (m.metadata && m.metadata.read))).length;
    if (cacheUnread > 0) return cacheUnread;
  }
  const activeTab = getActiveSubTab();
  const isActiveInboxMatch =
    selectedAgent &&
    String(selectedAgent).toLowerCase() === lower &&
    (activeNav === 1 || (activeTab && activeTab.kind === "peer" && String(activeTab.target || "").toLowerCase() === lower));
  if (agentMetaMap.size === 0 && isActiveInboxMatch && meshStats && typeof meshStats.unread === "number" && meshStats.unread > 0) {
    return meshStats.unread;
  }
  return 0;
}

function getFilteredAgents() {
  const q = String(peerFilterQuery || "").trim().toLowerCase();
  if (!q) return agentList;
  return agentList.filter((name) => String(name).toLowerCase().includes(q));
}

function ensureTargetSubTab(kind, target, activate = true) {
  const id = `${kind}:${target}`;
  const label = kind === "channel" ? `#${target}` : `@${target}`;
  let idx = subTabs.findIndex((t) => t.id === id);
  if (idx === -1) {
    subTabs.push({ id, kind, target, label, closable: true });
    idx = subTabs.length - 1;
  }
  if (activate) {
    activeSubTabIndex = idx;
    ensureActiveSubTabVisible = true;
    selectedMessageIndex = -1;
    scrollOffset = 0;
    if (kind === "peer") {
      selectedType = "peer";
      selectedAgent = target;
      const pIdx = agentList.indexOf(target);
      if (pIdx >= 0) agentIdx = pIdx;
      activeNav = 1; // Inbox
      lastNonHelpNav = 1;
      composerFocused = true;
      composerFocusZone = "input";
      syncWatchedInboxDir();
    } else if (kind === "channel") {
      selectedType = "channel";
      selectedChannel = target;
      const cIdx = channelList.indexOf(target);
      if (cIdx >= 0) channelIdx = cIdx;
      activeNav = 2; // Channels
      lastNonHelpNav = 2;
      composerFocused = true;
      composerFocusZone = "input";
    }
  }
  return idx;
}

function switchSubTab(indexOrId) {
  let idx = typeof indexOrId === "number"
    ? indexOrId
    : subTabs.findIndex((t) => t.id === indexOrId);
  if (idx < 0 || idx >= subTabs.length) idx = 0;
  activeSubTabIndex = idx;
  ensureActiveSubTabVisible = true;
  const tab = subTabs[idx];
  scrollOffset = 0;
  selectedMessageIndex = -1;
  if (!tab || tab.kind === "home") {
    activeNav = 0;
    lastNonHelpNav = 0;
  } else if (tab.kind === "peer") {
    selectedType = "peer";
    selectedAgent = tab.target || selectedAgent;
    const pIdx = agentList.indexOf(selectedAgent);
    if (pIdx >= 0) agentIdx = pIdx;
    activeNav = 1;
    lastNonHelpNav = 1;
    syncWatchedInboxDir();
  } else if (tab.kind === "channel") {
    selectedType = "channel";
    selectedChannel = tab.target || selectedChannel;
    const cIdx = channelList.indexOf(selectedChannel);
    if (cIdx >= 0) channelIdx = cIdx;
    activeNav = 2;
    lastNonHelpNav = 2;
  }
  composerFocused = true;
  composerFocusZone = "input";
  return tab;
}

function closeSubTab(indexOrId) {
  const idx = typeof indexOrId === "number"
    ? indexOrId
    : subTabs.findIndex((t) => t.id === indexOrId);
  if (idx <= 0 || idx >= subTabs.length) return false; // Cannot close Home
  if (!subTabs[idx].closable) return false;

  subTabs.splice(idx, 1);
  if (activeSubTabIndex >= subTabs.length) {
    activeSubTabIndex = subTabs.length - 1;
  } else if (activeSubTabIndex > idx) {
    activeSubTabIndex -= 1;
  } else if (activeSubTabIndex === idx) {
    activeSubTabIndex = Math.max(0, idx - 1);
  }
  subTabScrollOffset = Math.max(0, Math.min(subTabScrollOffset, Math.max(0, subTabs.length - 1)));
  switchSubTab(activeSubTabIndex);
  return true;
}

function openNewSubTab() {
  // Pick next peer or channel not currently open as a sub-tab
  for (const peer of agentList) {
    if (!subTabs.some((t) => t.id === `peer:${peer}`)) {
      ensureTargetSubTab("peer", peer, true);
      composerFocused = true;
      lastStatusNotice = `Opened @${peer} sub-tab`;
      return getActiveSubTab();
    }
  }
  for (const ch of channelList) {
    if (!subTabs.some((t) => t.id === `channel:${ch}`)) {
      ensureTargetSubTab("channel", ch, true);
      composerFocused = true;
      lastStatusNotice = `Opened #${ch} sub-tab`;
      return getActiveSubTab();
    }
  }
  // Fallback: cycle/open a fresh peer tab or switch to next peer
  const fallbackPeer = agentList[0] || "antigravity";
  ensureTargetSubTab("peer", fallbackPeer, true);
  composerFocused = true;
  lastStatusNotice = `Active tab: @${fallbackPeer}`;
  return getActiveSubTab();
}

function nextSubTab() {
  if (subTabs.length === 0) return null;
  return switchSubTab((activeSubTabIndex + 1) % subTabs.length);
}

function prevSubTab() {
  if (subTabs.length === 0) return null;
  return switchSubTab((activeSubTabIndex - 1 + subTabs.length) % subTabs.length);
}

function getFilteredSlashCommands(buf = composerBuffer) {
  const trimmed = String(buf || "").trimStart();
  if (!trimmed.startsWith("/")) return [];
  const token = trimmed.split(/\s+/)[0].toLowerCase();
  if (token === "/") return [...SLASH_COMMANDS];
  const prefixMatches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(token));
  if (prefixMatches.length > 0) return prefixMatches;
  const sub = token.slice(1);
  return SLASH_COMMANDS.filter((c) =>
    c.cmd.slice(1).includes(sub) ||
    (sub.length >= 2 && c.desc.toLowerCase().includes(sub))
  );
}

function isSlashMenuVisible() {
  if (slashMenuDismissed) return false;
  const buf = String(composerBuffer || "");
  if (!buf.startsWith("/")) return false;
  // Dismiss slash overlay once arguments begin after a space
  if (buf.trimStart().includes(" ")) return false;
  return getFilteredSlashCommands(buf).length > 0;
}

function getTargetDropdownItems() {
  const items = [];
  for (let i = 0; i < agentList.length; i++) {
    const name = agentList[i];
    const meta = agentMetaMap.get(name) || { total: 0, unread: 0 };
    const safeName = sanitizeTerminalText(name);
    items.push({
      type: "peer",
      name,
      index: i,
      label: `@${safeName}`,
      unread: meta.unread || 0,
      online: isPeerOnline(name)
    });
  }
  for (let i = 0; i < channelList.length; i++) {
    const name = channelList[i];
    const meta = channelMetaMap.get(name) || { total: 0 };
    const safeName = sanitizeTerminalText(name);
    items.push({
      type: "channel",
      name,
      index: i,
      label: `#${safeName}`,
      total: meta.total || 0
    });
  }
  items.push({
    type: "action",
    action: "refresh_targets",
    label: "↻ Refresh"
  });
  return items;
}

function formatCornerStats() {
  return `Peers: ${meshStats.peers} · Unread: ${meshStats.unread} · Ch: ${meshStats.channels} · DLQ: ${meshStats.dlq}`;
}

// ─────────────────────────────────────────────────────────────────
//  RENDER TOP BAR (Row 1: Top-Left Sub-Tabs + Top-Right [ ☰ Menu ])
// ─────────────────────────────────────────────────────────────────
function renderTopBar(cols) {
  const theme = getTheme();
  const row = 1;
  const compact = cols < 60;
  const menuText = rightSidebarOpen
    ? (compact ? "[ ☰·Open ]" : "[ ☰ Menu · Open ]")
    : (compact ? "[ ☰ ]" : "[ ☰ Menu ]");
  const menuW = stringWidth(menuText);
  const menuStartCol = Math.max(2, cols - menuW);
  const menuEndCol = menuStartCol + menuW - 1;

  // Build sub-tab descriptors with unread count badges for @peer tabs
  const maxLeftCols = Math.max(12, menuStartCol - 2);
  const newText = compact ? "[+]" : "[ + New ]";
  const newW = stringWidth(newText);

  const tabSpecs = subTabs.map((tab, i) => {
    const safeLabel = sanitizeTerminalText(tab.label);
    const isActive = i === activeSubTabIndex && (activeNav === 0 || activeNav === 1 || activeNav === 2);
    const pillBg = isActive ? theme.bgActiveNav : theme.bgSelected;
    const pillFg = isActive ? `${A.bold}${theme.fgOnActive}` : theme.fgSubtle;
    const peerTarget = tab.kind === "peer"
      ? (tab.target || String(tab.label || "").replace(/^@/, ""))
      : "";
    const unread = tab.kind === "peer" ? getPeerUnreadCount(peerTarget) : 0;
    const unreadPlain = unread > 0 ? ` (${unread})` : "";
    const unreadStyled = unread > 0
      ? ` ${isActive ? `${A.bold}${theme.fgOnActive}` : theme.fgWarn}(${unread})${pillFg}`
      : "";

    if (!tab.closable) {
      const text = `[ ${safeLabel} ]`;
      return {
        index: i,
        tab,
        closable: false,
        isActive,
        text,
        totalW: stringWidth(text),
        pillBg,
        pillFg
      };
    }
    const mainPlain = `[ ${safeLabel}${unreadPlain} `;
    const closePart = `× ]`;
    const mainW = stringWidth(mainPlain);
    const closeW = stringWidth(closePart);
    return {
      index: i,
      tab,
      closable: true,
      isActive,
      mainStyled: `[ ${safeLabel}${unreadStyled} `,
      closePart,
      mainW,
      closeW,
      totalW: mainW + closeW,
      pillBg,
      pillFg
    };
  });

  // Check if all sub-tabs + [ + New ] fit without overflow
  const totalNeededCols = 1 + tabSpecs.reduce((acc, s) => acc + s.totalW + 1, 0) + newW;
  const hasOverflow = totalNeededCols > maxLeftCols;

  let winStart = 0;
  let winEnd = tabSpecs.length;

  if (hasOverflow && tabSpecs.length > 0) {
    subTabScrollOffset = Math.max(0, Math.min(subTabScrollOffset, tabSpecs.length - 1));
    if (ensureActiveSubTabVisible && activeSubTabIndex < subTabScrollOffset) {
      subTabScrollOffset = Math.max(0, activeSubTabIndex);
    }

    const computeWindowEnd = (startIdx) => {
      const leftIndW = startIdx > 0 ? 4 : 0; // "[◀] "
      const availForTabs = Math.max(8, maxLeftCols - 2 - leftIndW - 4 - newW); // reserve "[▶] " + newW
      let used = 0;
      let end = startIdx;
      while (end < tabSpecs.length) {
        const w = tabSpecs[end].totalW + 1;
        if (end > startIdx && used + w > availForTabs) break;
        used += w;
        end++;
      }
      return Math.max(startIdx + 1, end);
    };

    winStart = subTabScrollOffset;
    winEnd = computeWindowEnd(winStart);
    if (ensureActiveSubTabVisible) {
      while (activeSubTabIndex >= winEnd && winStart < activeSubTabIndex) {
        winStart++;
        winEnd = computeWindowEnd(winStart);
      }
      subTabScrollOffset = winStart;
    }
  } else {
    subTabScrollOffset = 0;
  }
  ensureActiveSubTabVisible = false;

  let leftPlainCol = 2; // 1-based start after 1 leading space
  let leftRendered = " ";

  if (hasOverflow && winStart > 0) {
    const prevInd = "[◀]";
    const prevW = stringWidth(prevInd);
    if (leftPlainCol + prevW <= maxLeftCols) {
      registerHitbox(row, leftPlainCol, leftPlainCol + prevW - 1, "scroll_subtabs", { delta: -1 });
      leftRendered += `${theme.bgSelected}${theme.fgAccent}${prevInd}${A.reset}${theme.bgHeader} `;
      leftPlainCol += prevW + 1;
    }
  }

  for (let i = winStart; i < winEnd; i++) {
    const spec = tabSpecs[i];
    if (!spec.closable) {
      if (leftPlainCol + spec.totalW > maxLeftCols) break;
      registerHitbox(row, leftPlainCol, leftPlainCol + spec.totalW - 1, "switch_subtab", { index: spec.index, id: spec.tab.id });
      leftRendered += `${spec.pillBg}${spec.pillFg}${spec.text}${A.reset}${theme.bgHeader} `;
      leftPlainCol += spec.totalW + 1;
    } else {
      if (leftPlainCol + spec.totalW > maxLeftCols) break;
      registerHitbox(row, leftPlainCol, leftPlainCol + spec.mainW - 1, "switch_subtab", { index: spec.index, id: spec.tab.id });
      registerHitbox(row, leftPlainCol + spec.mainW, leftPlainCol + spec.totalW - 1, "close_subtab", { index: spec.index, id: spec.tab.id });

      const closeFg = spec.isActive ? theme.fgOnActive : theme.fgMuted;
      leftRendered += `${spec.pillBg}${spec.pillFg}${spec.mainStyled}${closeFg}${spec.closePart}${A.reset}${theme.bgHeader} `;
      leftPlainCol += spec.totalW + 1;
    }
  }

  if (hasOverflow && winEnd < tabSpecs.length) {
    const nextInd = "[▶]";
    const nextW = stringWidth(nextInd);
    if (leftPlainCol + nextW <= maxLeftCols) {
      registerHitbox(row, leftPlainCol, leftPlainCol + nextW - 1, "scroll_subtabs", { delta: 1 });
      leftRendered += `${theme.bgSelected}${theme.fgAccent}${nextInd}${A.reset}${theme.bgHeader} `;
      leftPlainCol += nextW + 1;
    }
  }

  // [ + New ] button
  if (leftPlainCol + newW <= maxLeftCols) {
    registerHitbox(row, leftPlainCol, leftPlainCol + newW - 1, "new_subtab", {});
    leftRendered += `${theme.bgSelected}${theme.fgAccent}${newText}${A.reset}${theme.bgHeader}`;
    leftPlainCol += newW;
  }

  // Gap between left sub-tabs and right [ ☰ Menu ]
  const gapW = Math.max(1, menuStartCol - leftPlainCol);
  registerHitbox(row, menuStartCol, menuEndCol, "toggle_sidebar", {});
  const menuBg = rightSidebarOpen ? theme.bgActiveNav : theme.bgSelected;
  const menuFg = rightSidebarOpen ? `${A.bold}${theme.fgOnActive}` : theme.fgAccent;
  const menuStyled = `${menuBg}${menuFg}${menuText}${A.reset}`;

  const line = `${theme.bgHeader}${leftRendered}${theme.bgHeader}${" ".repeat(gapW)}${menuStyled}${theme.bgHeader} `;
  return fitToWidth(line, cols, theme.bgHeader);
}

// ─────────────────────────────────────────────────────────────────
//  RENDER COLLAPSIBLE RIGHT-SIDE SIDEBAR (Hidden by Default)
// ─────────────────────────────────────────────────────────────────
function renderSidebar(widthOpt, heightOpt, startRow = 2, colsOpt) {
  const theme = getTheme();
  const screenCols = (screen.cols && screen.cols > 1) ? screen.cols : ((screen.width && screen.width > 1) ? screen.width : 80);
  const screenRows = (screen.rows && screen.rows > 1) ? screen.rows : 24;
  const cols = colsOpt ? Math.max(36, colsOpt) : Math.max(80, screenCols);
  const rows = heightOpt ? Math.max(12, heightOpt + 2) : Math.max(24, screenRows);
  const sW = widthOpt || Math.min(28, Math.max(22, Math.floor(cols * 0.26)));
  const sH = heightOpt || Math.max(18, rows - 2);

  if (!rightSidebarOpen) {
    return [];
  }

  const sidebarStartCol = cols - sW + 1;
  const sidebarEndCol = cols;
  const inner = Math.max(10, sW - 2);
  const isLight = settings.darkTheme === false;
  const borderFg = isLight ? theme.fgDimBorder : `${A.dim}${theme.fgAccent}`;
  const lines = [];

  // Top border
  lines.push(`${theme.bgSidebar}${borderFg}${B.tl}${B.h} ${A.bold}${theme.fgPrimary}MENU${A.reset}${theme.bgSidebar}${borderFg} ${B.h.repeat(Math.max(0, inner - 7))}${B.tr}${A.reset}`);

  // Vertical categories: Home, Inbox, Channels, Peers, Info, Settings, Help
  for (let i = 0; i < NAV_TABS.length && lines.length < sH - 2; i++) {
    const label = NAV_TABS[i];
    const isActive = i === activeNav;
    const screenRow = startRow + lines.length;
    registerHitbox(screenRow, sidebarStartCol, sidebarEndCol, "nav", { index: i, label });

    const indicator = isActive ? `${theme.fgAccent}›${A.reset}` : " ";
    const bg = isActive ? theme.bgActiveNav : theme.bgSidebar;
    const pill = isActive
      ? `${A.bold}${theme.fgOnActive}[ ${label} ]${A.reset}`
      : `${theme.fgSubtle}[ ${label} ]${A.reset}`;
    const rawContent = ` ${indicator} ${pill}`;
    lines.push(
      `${theme.bgSidebar}${borderFg}${B.v}${A.reset}${bg}` +
      fitToWidth(rawContent, inner, bg) +
      `${theme.bgSidebar}${borderFg}${B.v}${A.reset}`
    );
  }

  // Activity Log quick entry
  if (lines.length < sH - 3) {
    const isAct = activeNav === 7;
    const screenRow = startRow + lines.length;
    registerHitbox(screenRow, sidebarStartCol, sidebarEndCol, "open_activity", {});
    const indicator = isAct ? `${theme.fgAccent}›${A.reset}` : " ";
    const bg = isAct ? theme.bgActiveNav : theme.bgSidebar;
    const pill = isAct
      ? `${A.bold}${theme.fgOnActive}[ Activity ]${A.reset}`
      : `${theme.fgAccent}[ Activity ]${A.reset}`;
    lines.push(
      `${theme.bgSidebar}${borderFg}${B.v}${A.reset}${bg}` +
      fitToWidth(` ${indicator} ${pill}`, inner, bg) +
      `${theme.bgSidebar}${borderFg}${B.v}${A.reset}`
    );
  }

  // Peers section
  if (lines.length < sH - 3) {
    lines.push(
      `${theme.bgSidebar}${borderFg}${B.vl}${B.h} ${A.bold}${theme.fgPrimary}PEERS${A.reset}${theme.bgSidebar}${borderFg} ${B.h.repeat(Math.max(0, inner - 8))}${B.vr}${A.reset}`
    );
  }

  for (let i = 0; i < agentList.length && lines.length < sH - 3; i++) {
    const name = agentList[i];
    const safeName = sanitizeTerminalText(name);
    const isSelected = name === selectedAgent && (activeNav === 1 || selectedType === "peer");
    const screenRow = startRow + lines.length;
    registerHitbox(screenRow, sidebarStartCol, sidebarEndCol, "select_agent", { name, index: i });

    const { dot } = formatPeerStatusBadge(name, theme);
    const indicator = isSelected ? `${theme.fgAccent}›${A.reset}` : " ";
    const meta = agentMetaMap.get(name);
    const unread = meta && meta.unread > 0 ? ` ${theme.fgWarn}(${meta.unread})${A.reset}` : "";
    const bg = isSelected ? theme.bgSelected : theme.bgSidebar;
    const nameFmt = isSelected ? `${A.bold}${theme.fgPrimary}${safeName}${A.reset}` : `${theme.fgSubtle}${safeName}${A.reset}`;
    const rowContent = ` ${indicator} ${dot} ${nameFmt}${unread}`;

    lines.push(
      `${theme.bgSidebar}${borderFg}${B.v}${A.reset}${bg}` +
      fitToWidth(rowContent, inner, bg) +
      `${theme.bgSidebar}${borderFg}${B.v}${A.reset}`
    );
  }

  // Channels section
  if (lines.length < sH - 2) {
    lines.push(
      `${theme.bgSidebar}${borderFg}${B.vl}${B.h} ${A.bold}${theme.fgPrimary}CHANNELS${A.reset}${theme.bgSidebar}${borderFg} ${B.h.repeat(Math.max(0, inner - 11))}${B.vr}${A.reset}`
    );
  }

  for (let i = 0; i < channelList.length && lines.length < sH - 1; i++) {
    const name = channelList[i];
    const safeName = sanitizeTerminalText(name);
    const isSelected = name === selectedChannel && (activeNav === 2 || selectedType === "channel");
    const screenRow = startRow + lines.length;
    registerHitbox(screenRow, sidebarStartCol, sidebarEndCol, "select_channel", { name, index: i });

    const indicator = isSelected ? `${theme.fgChannel}›${A.reset}` : " ";
    const bg = isSelected ? theme.bgSelected : theme.bgSidebar;
    const nameFmt = isSelected ? `${A.bold}${theme.fgPrimary}#${safeName}${A.reset}` : `${theme.fgChannel}#${safeName}${A.reset}`;
    const rowContent = ` ${indicator} ${nameFmt}`;

    lines.push(
      `${theme.bgSidebar}${borderFg}${B.v}${A.reset}${bg}` +
      fitToWidth(rowContent, inner, bg) +
      `${theme.bgSidebar}${borderFg}${B.v}${A.reset}`
    );
  }

  // Close sidebar card cleanly immediately after Channels
  if (lines.length < sH) {
    lines.push(`${theme.bgSidebar}${borderFg}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`);
  }

  // Fill any remaining unused rows with clean bgSidebar padding (no empty box borders or grid stripes)
  while (lines.length < sH) {
    lines.push(fitToWidth("", sW, theme.bgSidebar));
  }

  return lines.slice(0, sH);
}

// ─────────────────────────────────────────────────────────────────
//  OVERLAY DROPDOWN BUILDERS (Target Selector & `/` Slash Commands)
// ─────────────────────────────────────────────────────────────────
function buildSlashDropdownBox(boxW) {
  const theme = getTheme();
  const matches = getFilteredSlashCommands(composerBuffer);
  if (matches.length === 0) return [];
  const inner = Math.max(20, boxW - 2);
  const maxVisible = Math.min(matches.length, 8);
  const clampedIdx = Math.max(0, Math.min(slashSelectedIndex, matches.length - 1));
  slashSelectedIndex = clampedIdx;

  // Keep selected item inside sliding window
  let startIdx = 0;
  if (clampedIdx >= maxVisible) {
    startIdx = clampedIdx - maxVisible + 1;
  }
  const visible = matches.slice(startIdx, startIdx + maxVisible);

  const lines = [];
  const title = ` / Commands (${matches.length}) `;
  lines.push(`${theme.bgDropdown}${theme.fgAccent}${B.tl}${B.h}${A.bold}${theme.fgPrimary}${title}${A.reset}${theme.bgDropdown}${theme.fgAccent}${B.h.repeat(Math.max(0, inner - stringWidth(title) - 1))}${B.tr}${A.reset}`);

  for (let i = 0; i < visible.length; i++) {
    const item = visible[i];
    const absIdx = startIdx + i;
    const isSel = absIdx === clampedIdx;
    const rowBg = isSel ? theme.bgActiveNav : theme.bgDropdown;
    const prefix = isSel ? `${theme.fgAccent}›${A.reset}` : " ";
    const cmdText = `${A.bold}${isSel ? theme.fgOnActive : theme.fgAccent}${item.syntax}${A.reset}`;
    const descText = `${theme.fgMuted} — ${item.desc}${A.reset}`;
    const rowInner = fitToWidth(` ${prefix} ${cmdText}${descText}`, inner, rowBg);
    lines.push({
      line: `${theme.bgDropdown}${theme.fgAccent}${B.v}${A.reset}${rowInner}${theme.bgDropdown}${theme.fgAccent}${B.v}${A.reset}`,
      action: "select_slash_command",
      payload: { cmd: item.cmd, syntax: item.syntax, hasArgs: item.hasArgs, index: absIdx }
    });
  }

  lines.push(`${theme.bgDropdown}${theme.fgAccent}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`);
  return lines;
}

function buildTargetDropdownBox(dropW, maxBoxRows = 18) {
  const theme = getTheme();
  const items = getTargetDropdownItems();
  const inner = Math.max(20, dropW - 2);
  const clampedIdx = Math.max(0, Math.min(targetDropdownIndex, items.length - 1));
  targetDropdownIndex = clampedIdx;

  const peerItems = items.filter((it) => it.type === "peer");
  const chItems = items.filter((it) => it.type === "channel");
  const actItems = items.filter((it) => it.type === "action");

  // Reserve room for Channels & [ ↻ Refresh ] + headers/borders so Channels never clip on busy meshes
  const maxChannelsShow = Math.min(chItems.length, maxBoxRows < 12 ? 2 : 4);
  const chromeRows = 2 + (peerItems.length > 0 ? 1 : 0) + (maxChannelsShow > 0 ? 1 : 0) + (actItems.length > 0 ? 1 : 0);
  const peerBudget = Math.max(1, Math.min(peerItems.length, maxBoxRows - chromeRows - maxChannelsShow - actItems.length));

  let peerStart = 0;
  if (clampedIdx < peerItems.length && clampedIdx >= peerBudget) {
    peerStart = Math.min(peerItems.length - peerBudget, clampedIdx - peerBudget + 1);
  }

  let chStart = 0;
  const chRelIdx = clampedIdx - peerItems.length;
  if (maxChannelsShow > 0 && chRelIdx >= 0 && chRelIdx < chItems.length && chRelIdx >= maxChannelsShow) {
    chStart = Math.min(chItems.length - maxChannelsShow, chRelIdx - maxChannelsShow + 1);
  }

  const visibleItems = [
    ...peerItems.slice(peerStart, peerStart + peerBudget),
    ...chItems.slice(chStart, chStart + maxChannelsShow),
    ...actItems
  ];

  const lines = [];
  const title = " Select Target ";
  lines.push(`${theme.bgDropdown}${theme.fgAccent}${B.tl}${B.h}${A.bold}${theme.fgPrimary}${title}${A.reset}${theme.bgDropdown}${theme.fgAccent}${B.h.repeat(Math.max(0, inner - stringWidth(title) - 1))}${B.tr}${A.reset}`);

  let addedPeersHeader = false;
  let addedChannelsHeader = false;

  for (const it of visibleItems) {
    if (it.type === "peer" && !addedPeersHeader) {
      addedPeersHeader = true;
      const moreTag = peerItems.length > peerBudget ? ` (${peerStart + 1}-${peerStart + peerBudget}/${peerItems.length})` : "";
      lines.push(`${theme.bgDropdown}${theme.fgAccent}${B.v}${A.reset}${fitToWidth(` ${theme.fgMuted}${A.bold}PEERS${moreTag}${A.reset}`, inner, theme.bgDropdown)}${theme.bgDropdown}${theme.fgAccent}${B.v}${A.reset}`);
    } else if (it.type === "channel" && !addedChannelsHeader) {
      addedChannelsHeader = true;
      const moreCh = chItems.length > maxChannelsShow ? ` (${chStart + 1}-${chStart + maxChannelsShow}/${chItems.length})` : "";
      lines.push(`${theme.bgDropdown}${theme.fgAccent}${B.v}${A.reset}${fitToWidth(` ${theme.fgMuted}${A.bold}CHANNELS${moreCh}${A.reset}`, inner, theme.bgDropdown)}${theme.bgDropdown}${theme.fgAccent}${B.v}${A.reset}`);
    } else if (it.type === "action") {
      lines.push(`${theme.bgDropdown}${theme.fgAccent}${B.vl}${B.h.repeat(inner)}${B.vr}${A.reset}`);
    }

    const globalIdx = items.indexOf(it);
    const isSel = globalIdx === clampedIdx;
    const rowBg = isSel ? theme.bgActiveNav : theme.bgDropdown;
    const marker = isSel ? `${theme.fgAccent}›${A.reset}` : " ";
    let rowText = "";
    if (it.type === "peer") {
      const dot = it.online ? `${theme.fgSelf}●${A.reset}` : `${theme.fgMuted}○${A.reset}`;
      const badge = it.unread > 0 ? ` ${theme.fgWarn}[${it.unread}]${A.reset}` : "";
      rowText = ` ${marker} ${dot} ${isSel ? `${A.bold}${theme.fgOnActive}` : theme.fgSubtle}${it.label}${A.reset}${badge}`;
    } else if (it.type === "channel") {
      rowText = ` ${marker} ${isSel ? `${A.bold}${theme.fgOnActive}` : theme.fgChannel}${it.label}${A.reset}`;
    } else {
      rowText = ` ${marker} ${A.bold}${isSel ? theme.fgOnActive : theme.fgAccent}[ ${it.label} ]${A.reset}`;
    }

    lines.push({
      line: `${theme.bgDropdown}${theme.fgAccent}${B.v}${A.reset}${fitToWidth(rowText, inner, rowBg)}${theme.bgDropdown}${theme.fgAccent}${B.v}${A.reset}`,
      action: it.type === "action" ? "btn_refresh" : "select_target_option",
      payload: it
    });
  }

  lines.push(`${theme.bgDropdown}${theme.fgAccent}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`);
  return lines;
}

// Overlay helper that writes centered/positioned box lines onto canvas lines and registers hitboxes
function overlayBoxOntoLines(canvasLines, startRowIdx, screenStartRow, leftCol0, boxEntries, minRowIdx = 0) {
  const bg = getCanvasBg();
  for (let i = 0; i < boxEntries.length; i++) {
    const r = startRowIdx + i;
    if (r < minRowIdx || r < 0 || r >= canvasLines.length) continue;
    const entry = boxEntries[i];
    const lineStr = typeof entry === "string" ? entry : entry.line;
    const lineW = stringWidth(lineStr);
    const padL = " ".repeat(Math.max(0, leftCol0));
    const existingW = stringWidth(canvasLines[r]);
    canvasLines[r] = fitToWidth(`${bg}${padL}${lineStr}`, existingW, bg);

    if (typeof entry === "object" && entry.action) {
      const endCol = Math.min(existingW, leftCol0 + lineW);
      registerHitbox(
        screenStartRow + r,
        leftCol0 + 1,
        endCol,
        entry.action,
        entry.payload || {},
        screenStartRow + r,
        10
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  CENTERED COMPOSER BLOCK RENDERER
// ─────────────────────────────────────────────────────────────────
function renderComposerPanel(mainWidth, availableHeight, screenStartRow, options = {}) {
  const theme = getTheme();
  const centeredVertically = Boolean(options.centeredVertically);
  const headingText = sanitizeTerminalText(options.headingText || "✉ Intercom");
  const subHeadingText = sanitizeTerminalText(options.subHeadingText || "");
  const minOverlayRow = Math.max(0, options.minOverlayRow || 0);
  const bg = theme.bgCanvas;
  const compact = mainWidth < 55;

  const minBoxW = Math.min(38, Math.max(20, mainWidth - 2));
  const boxW = Math.max(20, Math.min(74, mainWidth - 2, Math.max(minBoxW, Math.floor(mainWidth * 0.72))));
  const leftPad0 = Math.max(0, Math.floor((mainWidth - boxW) / 2));
  const boxInnerW = Math.max(10, boxW - 2);

  const safeTargetName = sanitizeTerminalText(selectedType === "channel" ? selectedChannel : selectedAgent);
  const targetLabel = selectedType === "channel" ? `#${safeTargetName}` : `@${safeTargetName}`;

  const buildControlsSpec = () => {
    const fullTarget = `To: [ ${targetLabel} ▾ ]`;
    const fullSend = "[ ↵ Send ]";
    const fullClear = "[ Clear ]";
    const fullW = stringWidth(fullTarget) + 2 + stringWidth(fullSend) + 2 + stringWidth(fullClear);
    if (!compact && fullW <= mainWidth - leftPad0) {
      return { targetBtnText: fullTarget, sendBtnText: fullSend, clearBtnText: fullClear, gapStr: "  ", gapW: 2 };
    }
    const maxTargetLabelW = Math.max(6, mainWidth - 24);
    const shortTarget = clipAnsi(targetLabel, maxTargetLabelW);
    const cTarget = `To:[${shortTarget}▾]`;
    const cSend = "[↵Send]";
    const cClear = "[Clr]";
    const cW = stringWidth(cTarget) + 1 + stringWidth(cSend) + 1 + stringWidth(cClear);
    if (cW <= mainWidth) {
      return { targetBtnText: cTarget, sendBtnText: cSend, clearBtnText: cClear, gapStr: " ", gapW: 1 };
    }
    const tightTarget = `[${clipAnsi(targetLabel, Math.max(4, mainWidth - 18))}▾]`;
    return { targetBtnText: tightTarget, sendBtnText: "[Send]", clearBtnText: "[Clr]", gapStr: " ", gapW: 1 };
  };
  const { targetBtnText, sendBtnText, clearBtnText, gapStr, gapW } = buildControlsSpec();

  const showHeading = Boolean(options.showHeading);
  const baseBlockRows = (showHeading ? 2 : 0) + 3 + 1 + (showHeading ? 1 : 0); // heading+gap, 3-row box, controls, hint

  const lines = Array.from({ length: availableHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  let composerStartRow = 0;
  if (centeredVertically) {
    composerStartRow = Math.max(0, Math.floor((availableHeight - baseBlockRows) / 2));
  } else {
    composerStartRow = Math.max(0, availableHeight - baseBlockRows);
  }

  // Check active dropdowns with available height above/below composer
  const showSlash = isSlashMenuVisible();
  const showTargetDrop = !showSlash && targetDropdownOpen;
  const dropW = Math.min(boxW, Math.max(22, Math.min(38, mainWidth - 2)));
  const maxAbove = Math.max(6, composerStartRow + (showHeading ? 2 : 0) - minOverlayRow);
  const maxBelow = Math.max(6, availableHeight - (composerStartRow + baseBlockRows - (showHeading ? 1 : 0)));
  const dropMaxRows = Math.max(maxAbove, maxBelow);
  const slashEntries = showSlash ? buildSlashDropdownBox(boxW) : [];
  const targetEntries = showTargetDrop ? buildTargetDropdownBox(dropW, dropMaxRows) : [];

  if (centeredVertically && (showSlash || showTargetDrop)) {
    const extraH = showSlash ? Math.min(slashEntries.length, 6) : Math.min(targetEntries.length, 8);
    const totalNeeded = baseBlockRows + (extraH > 0 ? 1 : 0);
    composerStartRow = Math.max(0, Math.floor((availableHeight - totalNeeded - Math.floor(extraH / 2)) / 2));
  }

  let curR = composerStartRow;

  // 1. Optional Centered Heading above composer
  if (showHeading && curR < availableHeight) {
    const fullTitle = subHeadingText
      ? `${A.bold}${theme.fgAccent}${headingText}${A.reset}  ${theme.fgMuted}·  ${subHeadingText}${A.reset}`
      : `${A.bold}${theme.fgAccent}${headingText}${A.reset}  ${theme.fgMuted}·  Pure Mesh Messaging${A.reset}`;
    const titleW = stringWidth(fullTitle);
    const titlePad = Math.max(0, Math.floor((mainWidth - titleW) / 2));
    lines[curR] = fitToWidth(`${bg}${" ".repeat(titlePad)}${fullTitle}`, mainWidth, bg);
    curR += 2; // 1 blank breathing row
  }

  // 2. Composer Input Box (3 rows)
  const boxTopRow = curR;
  const inputActive = composerFocused && composerFocusZone === "input";
  if (curR < availableHeight) {
    const borderColor = inputActive ? theme.fgAccent : theme.fgDimBorder;
    const labelStr = ` ${clipAnsi(targetLabel, Math.max(4, boxInnerW - 4))} `;
    const dashes = Math.max(1, boxInnerW - stringWidth(labelStr) - 1);
    const topLine = `${theme.bgInput}${borderColor}${B.tl}${B.h}${A.bold}${theme.fgPrimary}${labelStr}${A.reset}${theme.bgInput}${borderColor}${B.h.repeat(dashes)}${B.tr}${A.reset}`;
    lines[curR] = fitToWidth(`${bg}${" ".repeat(leftPad0)}${topLine}`, mainWidth, bg);
    curR++;
  }

  if (curR < availableHeight) {
    const borderColor = inputActive ? theme.fgAccent : theme.fgDimBorder;
    const promptPrefix = ` ${theme.fgAccent}›${A.reset}${theme.bgInput} `;
    const prefixW = stringWidth(promptPrefix);
    const inputAvail = Math.max(6, boxInnerW - prefixW - 1);
    const placeholder = `Message ${targetLabel} or type / for commands...`;
    const cursorView = renderCursorText(composerBuffer, composerCursor, inputAvail, inputActive, placeholder);
    const innerContent = fitToWidth(`${promptPrefix}${cursorView}`, boxInnerW, theme.bgInput);
    const midLine = `${theme.bgInput}${borderColor}${B.v}${A.reset}${innerContent}${theme.bgInput}${borderColor}${B.v}${A.reset}`;
    lines[curR] = fitToWidth(`${bg}${" ".repeat(leftPad0)}${midLine}`, mainWidth, bg);
    curR++;
  }

  if (curR < availableHeight) {
    const borderColor = inputActive ? theme.fgAccent : theme.fgDimBorder;
    const botLine = `${theme.bgInput}${borderColor}${B.bl}${B.h.repeat(boxInnerW)}${B.br}${A.reset}`;
    lines[curR] = fitToWidth(`${bg}${" ".repeat(leftPad0)}${botLine}`, mainWidth, bg);
    // Register hitbox for composer box
    registerHitbox(
      screenStartRow + boxTopRow,
      leftPad0 + 1,
      Math.min(mainWidth, leftPad0 + boxW),
      "focus_compose",
      {},
      screenStartRow + curR
    );
    curR++;
  }

  // 3. Controls Row: To: [ @target ▾ ]   [ ↵ Send ]   [ Clear ]
  const controlsRowIdx = curR;
  if (curR < availableHeight) {
    const targetW = stringWidth(targetBtnText);
    const sendW = stringWidth(sendBtnText);
    const clearW = stringWidth(clearBtnText);
    const totalCtrlW = targetW + gapW + sendW + gapW + clearW;
    const ctrlPad0 = totalCtrlW + leftPad0 <= mainWidth
      ? leftPad0
      : Math.max(0, Math.floor((mainWidth - totalCtrlW) / 2));

    const targetCol1 = ctrlPad0 + 1;
    const sendCol1 = targetCol1 + targetW + gapW;
    const clearCol1 = sendCol1 + sendW + gapW;

    const screenCtrlRow = screenStartRow + curR;
    if (targetCol1 <= mainWidth) {
      registerHitbox(screenCtrlRow, targetCol1, Math.min(mainWidth, targetCol1 + targetW - 1), "toggle_target_dropdown", {});
    }
    if (sendCol1 <= mainWidth) {
      registerHitbox(screenCtrlRow, sendCol1, Math.min(mainWidth, sendCol1 + sendW - 1), "btn_send", {});
    }
    if (clearCol1 <= mainWidth) {
      registerHitbox(screenCtrlRow, clearCol1, Math.min(mainWidth, clearCol1 + clearW - 1), "btn_clear", {});
    }

    const isTargetFocus = composerFocusZone === "target" || targetDropdownOpen;
    const isSendFocus = composerFocusZone === "send";
    const isClearFocus = composerFocusZone === "clear";

    const targetBg = isTargetFocus ? theme.bgActiveNav : theme.bgSelected;
    const targetFg = isTargetFocus ? `${A.bold}${A.underline}${theme.fgOnActive}` : `${A.bold}${theme.fgPrimary}`;
    const sendBg = isSendFocus ? theme.bgActiveNav : theme.bgActiveNav;
    const sendFg = isSendFocus ? `${A.bold}${A.underline}${theme.fgOnActive}` : `${A.bold}${theme.fgOnActive}`;
    const clearBg = isClearFocus ? theme.bgActiveNav : theme.bgSelected;
    const clearFg = isClearFocus ? `${A.bold}${A.underline}${theme.fgOnActive}` : theme.fgMuted;

    const targetStyled = `${targetBg}${targetFg}${targetBtnText}${A.reset}`;
    const sendStyled = `${sendBg}${sendFg}${sendBtnText}${A.reset}`;
    const clearStyled = `${clearBg}${clearFg}${clearBtnText}${A.reset}`;

    const ctrlLine = `${bg}${" ".repeat(ctrlPad0)}${targetStyled}${bg}${gapStr}${sendStyled}${bg}${gapStr}${clearStyled}`;
    lines[curR] = fitToWidth(ctrlLine, mainWidth, bg);
    curR++;
  }

  // 4. Subtle Hint Row on Home/Empty
  if (showHeading && curR < availableHeight) {
    const hint = compact
      ? `${theme.fgMuted}[Tab] Tabs  [/] Cmds  [Esc then z] Zen  [Enter] Send${A.reset}`
      : `${theme.fgMuted}[Tab] Sub-Tabs  [/] Commands  [Ctrl+B] Menu  [Esc then z] Zen  [Enter] Send${A.reset}`;
    const hintW = stringWidth(hint);
    const hintPad = Math.max(0, Math.floor((mainWidth - hintW) / 2));
    lines[curR] = fitToWidth(`${bg}${" ".repeat(hintPad)}${hint}`, mainWidth, bg);
    curR++;
  }

  // 5. Anchor Floating Dropdowns cleanly (below if room, otherwise above without overlapping minOverlayRow)
  if (showSlash && slashEntries.length > 0) {
    const roomBelow = availableHeight - (boxTopRow + 3);
    const anchorStart = roomBelow >= slashEntries.length
      ? boxTopRow + 3
      : Math.max(minOverlayRow, boxTopRow - slashEntries.length);
    overlayBoxOntoLines(lines, anchorStart, screenStartRow, leftPad0, slashEntries, minOverlayRow);
  } else if (showTargetDrop && targetEntries.length > 0) {
    const roomBelow = availableHeight - (controlsRowIdx + 1);
    const anchorStart = roomBelow >= targetEntries.length
      ? controlsRowIdx + 1
      : Math.max(minOverlayRow, boxTopRow - targetEntries.length);
    const dropPad0 = Math.max(0, Math.min(leftPad0, mainWidth - dropW));
    overlayBoxOntoLines(lines, anchorStart, screenStartRow, dropPad0, targetEntries, minOverlayRow);
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────
//  CHANNELS BAR HELPER
// ─────────────────────────────────────────────────────────────────
function renderChannelsBar(mainWidth, screenBarRow) {
  const theme = getTheme();
  const bg = theme.bgHeader;
  const compact = mainWidth < 55;
  const addBtn = compact ? "[+Ch]" : "[ + Channel ]";
  const addW = stringWidth(addBtn);
  const maxPillsCol = Math.max(6, mainWidth - addW - 2);

  let col1 = 2; // 1 leading space
  let barStr = " ";

  for (let i = 0; i < channelList.length; i++) {
    const ch = channelList[i];
    const safeCh = sanitizeTerminalText(ch);
    const isSel = ch === selectedChannel && selectedType === "channel";
    const pillText = `[ #${safeCh} ]`;
    const pillW = stringWidth(pillText);
    if (col1 + pillW > maxPillsCol) break;

    registerHitbox(screenBarRow, col1, col1 + pillW - 1, "select_channel", { name: ch, index: i });
    const pillBg = isSel ? theme.bgActiveNav : theme.bgSelected;
    const pillFg = isSel ? `${A.bold}${theme.fgOnActive}` : theme.fgChannel;
    barStr += `${pillBg}${pillFg}${pillText}${A.reset}${bg} `;
    col1 += pillW + 1;
  }

  const gap = Math.max(1, mainWidth - col1 - addW);
  const addCol1 = col1 + gap;
  if (addCol1 + addW - 1 <= mainWidth) {
    registerHitbox(screenBarRow, addCol1, addCol1 + addW - 1, "new_channel_prompt", {});
  }
  barStr += `${" ".repeat(gap)}${theme.bgSelected}${theme.fgAccent}${addBtn}${A.reset}`;
  return fitToWidth(barStr, mainWidth, bg);
}

// ─────────────────────────────────────────────────────────────────
//  CONVERSATION / INBOX / CHANNELS RENDERER (Reads Cached Buffer Only)
// ─────────────────────────────────────────────────────────────────
function renderThreadAndComposer(mainWidth, bodyHeight, screenStartRow, isChannel) {
  const theme = getTheme();
  const bg = theme.bgCanvas;
  const compact = mainWidth < 55;
  const targetName = isChannel ? selectedChannel : selectedAgent;
  const safeTargetName = sanitizeTerminalText(targetName);
  const cacheEntry = threadCache.get(getThreadCacheKey(isChannel, targetName));
  const msgs = (cacheEntry && Array.isArray(cacheEntry.messages)) ? cacheEntry.messages : [];

  // Empty conversation -> Centered Composer (plus Channels Bar on Channels view when not in Zen mode)
  if (!msgs || msgs.length === 0) {
    const prefix = isChannel ? `#${safeTargetName}` : `@${safeTargetName}`;
    if (isChannel && bodyHeight >= 10 && !zenMode) {
      const chBar = renderChannelsBar(mainWidth, screenStartRow);
      const compLines = renderComposerPanel(mainWidth, bodyHeight - 1, screenStartRow + 1, {
        centeredVertically: true,
        showHeading: !zenMode,
        headingText: `✉ Intercom`,
        subHeadingText: `${prefix} · No messages yet`
      });
      return [chBar, ...compLines];
    }
    return renderComposerPanel(mainWidth, bodyHeight, screenStartRow, {
      centeredVertically: true,
      showHeading: !zenMode,
      headingText: `✉ Intercom`,
      subHeadingText: `${prefix} · No messages yet`
    });
  }

  // Active conversation with messages -> clean header (suppressed in Zen mode) + speech bubbles + centered-width composer
  const headerRows = zenMode ? 0 : (isChannel ? 2 : 1);
  const composerH = Math.min(Math.max(4, bodyHeight - headerRows - 2), 4); // 3-row box + 1-row controls
  const streamTotalH = Math.max(headerRows + 2, bodyHeight - composerH);
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  if (!zenMode) {
    // Header row (row 0 of body) — right-aligned buttons never shift or clip on narrow widths
    const targetTag = isChannel
      ? `${theme.fgChannel}${A.bold}#${safeTargetName}${A.reset}`
      : `${theme.fgAccent}${A.bold}@${safeTargetName}${A.reset}`;
    const statusBadge = isChannel ? null : formatPeerStatusBadge(targetName, theme);
    const statusPill = isChannel
      ? `${theme.fgMuted}· Topic Channel (${msgs.length})${A.reset}`
      : `${statusBadge.label}${A.reset} ${theme.fgMuted}· Thread (${msgs.length})${A.reset}`;

    const refreshBtn = compact ? "[↻]" : "[ ↻ Refresh ]";
    const refreshW = stringWidth(refreshBtn);
    const markReadBtn = !isChannel ? (compact ? "[✓Read]" : "[ ✓ Mark Read ]") : "";
    const markReadW = markReadBtn ? stringWidth(markReadBtn) : 0;

    const rightGroupW = markReadBtn ? (markReadW + 1 + refreshW) : refreshW;
    const rightStart0 = Math.max(2, mainWidth - rightGroupW - 1);
    const maxLeftW = Math.max(4, rightStart0 - 1);
    const rawLeftHdr = `  ${targetTag}  ${statusPill}`;
    const clippedLeftHdr = clipAnsi(rawLeftHdr, maxLeftW);
    const hdrGap = Math.max(1, rightStart0 - stringWidth(clippedLeftHdr));

    let rightRendered = "";
    let curCol1 = rightStart0 + 1;
    if (markReadBtn) {
      registerHitbox(screenStartRow, curCol1, Math.min(mainWidth, curCol1 + markReadW - 1), "btn_mark_read", { agent: targetName });
      rightRendered += `${theme.bgSelected}${theme.fgSelf}${markReadBtn}${A.reset}${bg} `;
      curCol1 += markReadW + 1;
    }
    registerHitbox(screenStartRow, curCol1, Math.min(mainWidth, curCol1 + refreshW - 1), "btn_refresh", {});
    rightRendered += `${theme.bgSelected}${theme.fgAccent}${refreshBtn}${A.reset}`;

    lines[0] = fitToWidth(`${bg}${clippedLeftHdr}${bg}${" ".repeat(hdrGap)}${rightRendered}`, mainWidth, bg);

    if (isChannel && bodyHeight > 1) {
      lines[1] = renderChannelsBar(mainWidth, screenStartRow + 1);
    }
  }

  // Build speech bubbles centered cleanly
  const maxStreamW = Math.max(20, mainWidth - 2);
  const streamW = Math.min(82, maxStreamW, Math.max(Math.min(40, maxStreamW), Math.floor(mainWidth * 0.78)));
  const bubbleW = Math.max(20, Math.min(streamW, maxStreamW));
  const streamPad0 = Math.max(0, Math.floor((mainWidth - bubbleW) / 2));
  const bubbleRows = [];
  const recent = msgs.slice(-25);
  const selfIdentity = getSelfIdentity().toLowerCase();

  if (selectedMessageIndex >= recent.length) {
    selectedMessageIndex = recent.length - 1;
  }

  for (let mIdx = 0; mIdx < recent.length; mIdx++) {
    const m = recent[mIdx];
    const isSelectedMsg = mIdx === selectedMessageIndex;
    const rawFrom = m.from || m.sender || "unknown";
    const from = sanitizeTerminalText(rawFrom);
    const fromLower = String(rawFrom || "").toLowerCase();
    const isSelf = fromLower === selfIdentity || fromLower === "operator" || fromLower === "exdelegate";
    const tsRaw = String(m.timestamp || "");
    const tsSlice = tsRaw.includes("T") ? tsRaw.split("T")[1].slice(0, 8) : tsRaw;
    const ts = settings.showTimestamps ? sanitizeTerminalText(tsSlice) : "";
    const isRead = Boolean(m.read || (m.metadata && m.metadata.read));
    const receiptBadge = settings.readReceipts && !isChannel
      ? (isRead ? ` ${theme.fgMuted}[READ]${A.reset}` : ` ${theme.fgWarn}[UNREAD]${A.reset}`)
      : "";
    const body = sanitizeTerminalText(
      String(m.message || (m.payload && m.payload.message) || m.body || "").trim(),
      { allowNewlines: true }
    );

    const senderColor = isChannel ? theme.fgChannel : (isSelf ? theme.fgSelf : theme.fgAccent);
    const borderColor = isSelectedMsg ? theme.fgWarn : senderColor;
    const bubbleBg = isSelectedMsg ? theme.bgSelected : (isSelf ? theme.bgBubbleSelf : theme.bgBubble);
    const tsPart = ts ? `  ${theme.fgMuted}${ts}${A.reset}` : "";
    const selPrefix = isSelectedMsg ? `${theme.fgWarn}›${A.reset} ` : "";
    const rawHeaderLabel = `${selPrefix}${senderColor}${A.bold}@${from}${A.reset}${tsPart}${receiptBadge}`;
    const headerLabel = clipAnsi(rawHeaderLabel, Math.max(6, bubbleW - 6));
    const dashLen = Math.max(1, bubbleW - stringWidth(headerLabel) - 5);

    bubbleRows.push({
      text: `${borderColor}${B.tl}${B.h}${A.reset} ${headerLabel} ${borderColor}${B.h.repeat(dashLen)}${B.tr}${A.reset}`,
      hitboxes: [{ relStartCol: 1, relEndCol: bubbleW, action: "select_message", payload: { index: mIdx } }]
    });

    const wrapped = wrapText(body, Math.max(8, bubbleW - 4));
    for (const wl of wrapped) {
      const innerText = fitToWidth(` ${theme.fgPrimary}${wl}${A.reset}`, bubbleW - 2, bubbleBg);
      bubbleRows.push({
        text: `${borderColor}${B.v}${A.reset}${innerText}${borderColor}${B.v}${A.reset}`,
        hitboxes: [{ relStartCol: 1, relEndCol: bubbleW, action: "select_message", payload: { index: mIdx } }]
      });
    }

    if (isSelectedMsg) {
      const replyBtn = compact ? "[↩Reply]" : "[ ↩ Reply ]";
      const fwdBtn = compact ? "[↪Fwd]" : "[ ↪ Forward ]";
      const replyW = stringWidth(replyBtn);
      const fwdW = stringWidth(fwdBtn);
      const actInner = fitToWidth(
        ` ${theme.bgActiveNav}${A.bold}${theme.fgOnActive}${replyBtn}${A.reset}${bubbleBg}  ${theme.bgHeader}${theme.fgAccent}${fwdBtn}${A.reset}`,
        bubbleW - 2,
        bubbleBg
      );
      const replyRelStart = 3; // border(1) + space(1) + 1-based
      const replyRelEnd = replyRelStart + replyW - 1;
      const fwdRelStart = replyRelEnd + 3; // 2 spaces gap
      const fwdRelEnd = fwdRelStart + fwdW - 1;
      bubbleRows.push({
        text: `${borderColor}${B.v}${A.reset}${actInner}${borderColor}${B.v}${A.reset}`,
        hitboxes: [
          { relStartCol: 1, relEndCol: bubbleW, action: "select_message", payload: { index: mIdx } },
          { relStartCol: replyRelStart, relEndCol: replyRelEnd, action: "reply_message", payload: { index: mIdx, from, body } },
          { relStartCol: fwdRelStart, relEndCol: fwdRelEnd, action: "forward_message", payload: { index: mIdx, from, body } }
        ]
      });
    }

    bubbleRows.push({
      text: `${borderColor}${B.bl}${B.h.repeat(bubbleW - 2)}${B.br}${A.reset}`,
      hitboxes: [{ relStartCol: 1, relEndCol: bubbleW, action: "select_message", payload: { index: mIdx } }]
    });
    bubbleRows.push({ text: "", hitboxes: [] });
  }

  // Slice visible window with scrollOffset
  const visibleH = Math.max(1, streamTotalH - headerRows);
  const maxScroll = Math.max(0, bubbleRows.length - visibleH);
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const startIdx = Math.max(0, bubbleRows.length - visibleH - scrollOffset);
  const slice = bubbleRows.slice(startIdx, startIdx + visibleH);

  for (let i = 0; i < slice.length; i++) {
    const r = headerRows + i;
    if (r >= streamTotalH) break;
    const rowObj = slice[i];
    lines[r] = fitToWidth(`${bg}${" ".repeat(streamPad0)}${rowObj.text}`, mainWidth, bg);
    for (const hb of rowObj.hitboxes) {
      const sCol = Math.max(1, streamPad0 + hb.relStartCol);
      const eCol = Math.min(mainWidth, streamPad0 + hb.relEndCol);
      if (sCol <= eCol) {
        registerHitbox(screenStartRow + r, sCol, eCol, hb.action, hb.payload);
      }
    }
  }

  // Render centered-width composer at bottom of thread
  const composerLines = renderComposerPanel(mainWidth, bodyHeight, screenStartRow, {
    centeredVertically: false,
    showHeading: false,
    minOverlayRow: headerRows
  });
  // Copy bottom composer rows (and any anchored overlay dropdowns above the composer!)
  const composerTopRow = bodyHeight - composerH;
  const showOverlay = isSlashMenuVisible() || targetDropdownOpen;
  const copyStart = showOverlay ? headerRows : composerTopRow;
  for (let r = copyStart; r < bodyHeight; r++) {
    if (r < composerTopRow) {
      if (stripAnsi(composerLines[r]).trim().length > 0) {
        lines[r] = composerLines[r];
      }
    } else {
      lines[r] = composerLines[r];
    }
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────
//  PEERS, INFO, SETTINGS, HELP & ACTIVITY VIEWS
// ─────────────────────────────────────────────────────────────────
function renderPeersView(mainWidth, bodyHeight, screenStartRow) {
  const theme = getTheme();
  const bg = theme.bgCanvas;
  const compact = mainWidth < 55;
  const maxCardW = Math.max(24, mainWidth - 2);
  const cardW = Math.min(76, maxCardW, Math.max(Math.min(42, maxCardW), Math.floor(mainWidth * 0.80)));
  const padL0 = Math.max(0, Math.floor((mainWidth - cardW) / 2));
  const inner = Math.max(12, cardW - 2);
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  const filterBtn = compact || cardW < 44
    ? (peerFilterActive || peerFilterQuery ? "[/·On]" : "[/]")
    : (peerFilterActive || peerFilterQuery ? "[ / Filter · On ]" : "[ / Filter ]");
  const refreshBtn = compact || cardW < 44 ? "[↻]" : "[ ↻ Refresh ]";
  const filterW = stringWidth(filterBtn);
  const refW = stringWidth(refreshBtn);
  const rightBtnsW = filterW + 1 + refW;

  let r = 1;
  if (r < bodyHeight) {
    const rawHdr = compact ? `${A.bold}${theme.fgAccent}● Peers${A.reset}` : `${A.bold}${theme.fgAccent}● Active Agent Peers${A.reset}`;
    const hdr = clipAnsi(rawHdr, Math.max(4, cardW - rightBtnsW - 1));
    const hdrW = stringWidth(hdr);
    const gap = Math.max(1, cardW - hdrW - rightBtnsW);
    const filterCol1 = padL0 + hdrW + gap + 1;
    const refCol1 = filterCol1 + filterW + 1;
    if (filterCol1 <= mainWidth) {
      registerHitbox(screenStartRow + r, filterCol1, Math.min(mainWidth, filterCol1 + filterW - 1), "toggle_peer_filter", {});
    }
    if (refCol1 <= mainWidth) {
      registerHitbox(screenStartRow + r, refCol1, Math.min(mainWidth, refCol1 + refW - 1), "btn_refresh", {});
    }
    const filterBg = (peerFilterActive || peerFilterQuery) ? theme.bgActiveNav : theme.bgSelected;
    const filterFg = (peerFilterActive || peerFilterQuery) ? `${A.bold}${theme.fgOnActive}` : theme.fgAccent;
    lines[r] = fitToWidth(
      `${bg}${" ".repeat(padL0)}${hdr}${bg}${" ".repeat(gap)}${filterBg}${filterFg}${filterBtn}${A.reset}${bg} ${theme.bgSelected}${theme.fgAccent}${refreshBtn}${A.reset}`,
      mainWidth,
      bg
    );
    r += 1;
  }

  const filteredAgents = getFilteredAgents();

  if ((peerFilterActive || peerFilterQuery.length > 0) && r < bodyHeight - 3) {
    const countTag = `${theme.fgMuted}(${filteredAgents.length}/${agentList.length})${A.reset}`;
    const clearTag = peerFilterQuery.length > 0 ? ` ${theme.bgSelected}${theme.fgMuted}[×]${A.reset}` : "";
    const prefix = `${theme.fgAccent}Filter:${A.reset} `;
    const suffixW = stringWidth(countTag) + (peerFilterQuery.length > 0 ? 4 : 0) + 1;
    const inputAvail = Math.max(6, cardW - stringWidth(prefix) - suffixW);
    const cursorView = renderCursorText(peerFilterQuery, peerFilterCursor, inputAvail, peerFilterActive, "type peer name...");
    const rowStr = `${prefix}${cursorView} ${countTag}${clearTag}`;
    const clippedRow = clipAnsi(rowStr, cardW);
    const filterInputEnd = Math.min(mainWidth, padL0 + cardW - (peerFilterQuery.length > 0 ? 3 : 0));
    registerHitbox(screenStartRow + r, padL0 + 1, filterInputEnd, "focus_peer_filter", {});
    if (peerFilterQuery.length > 0) {
      const clearCol1 = Math.min(mainWidth, padL0 + stringWidth(`${prefix}${cursorView} ${countTag} `) + 1);
      registerHitbox(screenStartRow + r, clearCol1, Math.min(mainWidth, clearCol1 + 2), "clear_peer_filter", {});
    }
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${clippedRow}`, mainWidth, bg);
  } else {
    r++;
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }

  const listMaxRows = Math.max(1, bodyHeight - r - 1);
  if (filteredAgents.length === 0) {
    if (r < bodyHeight - 1) {
      const msg = peerFilterQuery
        ? `No peers matching "${sanitizeTerminalText(peerFilterQuery)}"`
        : "No active peers discovered";
      const row = fitToWidth(`  ${theme.fgMuted}${msg}${A.reset}`, inner, theme.bgInput);
      lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${row}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
    }
  } else {
    const needsScroll = filteredAgents.length > listMaxRows;
    const maxStart = Math.max(0, filteredAgents.length - Math.max(1, listMaxRows - (needsScroll ? 1 : 0)));
    let startIdx = needsScroll ? Math.max(0, Math.min(scrollOffset, maxStart)) : 0;
    scrollOffset = startIdx;

    let availRows = listMaxRows;
    const hasAbove = startIdx > 0;
    if (hasAbove) availRows = Math.max(1, availRows - 1);
    let hasBelow = startIdx + availRows < filteredAgents.length;
    if (hasBelow && availRows > 1) availRows -= 1;
    hasBelow = startIdx + availRows < filteredAgents.length;

    if (hasAbove && r < bodyHeight - 1) {
      const hint = fitToWidth(`  ${theme.fgAccent}↑ ${startIdx} more above (scroll up)${A.reset}`, inner, theme.bgInput);
      registerHitbox(screenStartRow + r, padL0 + 1, Math.min(mainWidth, padL0 + cardW), "scroll_list", { delta: -3 });
      lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${hint}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
    }

    const endIdx = Math.min(filteredAgents.length, startIdx + availRows);
    for (let i = startIdx; i < endIdx && r < bodyHeight - 1; i++) {
      const name = filteredAgents[i];
      const realIdx = agentList.indexOf(name);
      const safeName = sanitizeTerminalText(name);
      const meta = agentMetaMap.get(name) || { total: 0, unread: 0 };
      const { dot } = formatPeerStatusBadge(name, theme);
      const unread = meta.unread > 0 ? ` ${theme.fgWarn}[${meta.unread} unread]${A.reset}` : "";
      const total = meta.total > 0 ? ` ${theme.fgMuted}(${meta.total} msgs)${A.reset}` : ` ${theme.fgMuted}(idle)${A.reset}`;
      const isSel = name === selectedAgent;
      const rowBg = isSel ? theme.bgSelected : theme.bgInput;
      const openBadgeText = cardW < 40 ? "[Open]" : "[ Open ]";
      const openBadge = `${theme.fgAccent}${openBadgeText}${A.reset}`;
      const maxLeftW = Math.max(8, inner - stringWidth(openBadgeText) - 2);
      const rawLeft = `  ${dot}  ${A.bold}${theme.fgPrimary}@${safeName}${A.reset}${unread}${total}`;
      const leftPart = clipAnsi(rawLeft, maxLeftW);
      const gap = Math.max(1, inner - stringWidth(leftPart) - stringWidth(openBadgeText) - 1);
      const content = fitToWidth(`${leftPart}${" ".repeat(gap)}${openBadge}`, inner, rowBg);

      registerHitbox(screenStartRow + r, padL0 + 1, Math.min(mainWidth, padL0 + cardW), "select_agent", { name, index: realIdx >= 0 ? realIdx : i });
      lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${content}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
    }

    if (hasBelow && r < bodyHeight - 1) {
      const rem = filteredAgents.length - endIdx;
      const hint = fitToWidth(`  ${theme.fgAccent}↓ ${rem} more below (scroll down)${A.reset}`, inner, theme.bgInput);
      registerHitbox(screenStartRow + r, padL0 + 1, Math.min(mainWidth, padL0 + cardW), "scroll_list", { delta: 3 });
      lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${hint}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
    }
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  return lines;
}

function renderInfoView(mainWidth, bodyHeight, screenStartRow) {
  const theme = getTheme();
  const bg = theme.bgCanvas;
  const compact = mainWidth < 55;
  const maxCardW = Math.max(24, mainWidth - 2);
  const cardW = Math.min(78, maxCardW, Math.max(Math.min(44, maxCardW), Math.floor(mainWidth * 0.80)));
  const padL0 = Math.max(0, Math.floor((mainWidth - cardW) / 2));
  const inner = Math.max(12, cardW - 2);
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  const refreshBtn = compact || cardW < 46 ? "[↻]" : "[ ↻ Refresh ]";
  const refW = stringWidth(refreshBtn);

  let r = 1;
  if (r < bodyHeight) {
    const rawHdr = compact
      ? `${A.bold}${theme.fgAccent}ℹ Mesh Health & Info${A.reset}`
      : `${A.bold}${theme.fgAccent}ℹ Intercom Mesh Health & System Info${A.reset}`;
    const hdr = clipAnsi(rawHdr, Math.max(4, cardW - refW - 1));
    const hdrW = stringWidth(hdr);
    const gap = Math.max(1, cardW - hdrW - refW);
    const refCol1 = padL0 + hdrW + gap + 1;
    registerHitbox(screenStartRow + r, refCol1, Math.min(mainWidth, refCol1 + refW - 1), "btn_refresh", {});
    lines[r] = fitToWidth(`${bg}${" ".repeat(padL0)}${hdr}${bg}${" ".repeat(gap)}${theme.bgActiveNav}${A.bold}${theme.fgOnActive}${refreshBtn}${A.reset}`, mainWidth, bg);
    r += 2;
  }

  const svcs = meshInfoCache.services || {};
  const svcRow = (label, svc) => {
    const st = svc && svc.status;
    const pill = st === "ONLINE"
      ? `${theme.fgSelf}[ONLINE] ${A.reset}`
      : (st === "OFFLINE" ? `${theme.fgDanger}[OFFLINE]${A.reset}` : `${theme.fgMuted}[CACHED] ${A.reset}`);
    return fitToWidth(`  ${pill}  ${A.bold}${theme.fgPrimary}${label}${A.reset}`, inner, theme.bgInput);
  };

  const rowsToDraw = [
    svcRow("Pi Broker Service   ", svcs.piBroker),
    svcRow("OpenCode API Engine ", svcs.opencodeApi),
    svcRow("Hermes AI Gateway   ", svcs.hermesGateway),
    svcRow("Local Mesh Daemon   ", svcs.intercomDaemon),
    fitToWidth("", inner, theme.bgInput),
    fitToWidth(`  ${theme.fgMuted}Registered Peers :${A.reset} ${theme.fgAccent}${meshStats.peers}${A.reset}    ${theme.fgMuted}Unread:${A.reset} ${theme.fgWarn}${meshStats.unread}${A.reset}`, inner, theme.bgInput),
    fitToWidth(`  ${theme.fgMuted}Topic Channels   :${A.reset} ${theme.fgChannel}${meshStats.channels}${A.reset}    ${theme.fgMuted}DLQ   :${A.reset} ${meshStats.dlq > 0 ? theme.fgDanger : theme.fgSelf}${meshStats.dlq} failed${A.reset}`, inner, theme.bgInput),
    fitToWidth(`  ${theme.fgMuted}Mesh Root        :${A.reset} ${theme.fgSubtle}${sanitizeTerminalText(getMeshDir())}${A.reset}`, inner, theme.bgInput),
    fitToWidth(`  ${theme.fgMuted}Daemon Port      :${A.reset} ${theme.fgSubtle}${getPort() || 4150}${A.reset}`, inner, theme.bgInput),
    fitToWidth("", inner, theme.bgInput),
    fitToWidth(`  ${theme.fgSelf}✔${A.reset} ${theme.fgMuted}Pure Messaging Mode · NTFS Safe-Rename · Directory Jail Verified${A.reset}`, inner, theme.bgInput)
  ];

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }
  for (const content of rowsToDraw) {
    if (r >= bodyHeight - 1) break;
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${content}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
  }
  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  if (r + 1 < bodyHeight && activityLog.length > 0) {
    r++;
    const actBtn = compact || cardW < 44 ? "[Activity]" : "[ View Activity ]";
    const actW = stringWidth(actBtn);
    const rawActHdr = `${A.bold}${theme.fgAccent}⏱ Recent Activity${A.reset}`;
    const actHdr = clipAnsi(rawActHdr, Math.max(4, cardW - actW - 1));
    const actHdrW = stringWidth(actHdr);
    const actGap = Math.max(1, cardW - actHdrW - actW);
    const actCol1 = padL0 + actHdrW + actGap + 1;
    registerHitbox(screenStartRow + r, actCol1, Math.min(mainWidth, actCol1 + actW - 1), "open_activity", {});
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${actHdr}${bg}${" ".repeat(actGap)}${theme.bgSelected}${theme.fgAccent}${actBtn}${A.reset}`, mainWidth, bg);
    for (let i = 0; i < Math.min(3, activityLog.length) && r < bodyHeight; i++) {
      lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}  ${theme.fgMuted}${sanitizeTerminalText(activityLog[i])}${A.reset}`, mainWidth, bg);
    }
  }
  return lines;
}

function renderActivityView(mainWidth, bodyHeight, screenStartRow) {
  const theme = getTheme();
  const bg = theme.bgCanvas;
  const compact = mainWidth < 55;
  const maxCardW = Math.max(24, mainWidth - 2);
  const cardW = Math.min(82, maxCardW, Math.max(Math.min(44, maxCardW), Math.floor(mainWidth * 0.82)));
  const padL0 = Math.max(0, Math.floor((mainWidth - cardW) / 2));
  const inner = Math.max(12, cardW - 2);
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  const clearBtn = compact || cardW < 46 ? "[Clear]" : "[ Clear Log ]";
  const clearW = stringWidth(clearBtn);

  let r = 1;
  if (r < bodyHeight) {
    const rawHdr = `${A.bold}${theme.fgAccent}⏱ Mesh Activity Stream (${activityLog.length})${A.reset}`;
    const hdr = clipAnsi(rawHdr, Math.max(4, cardW - clearW - 1));
    const hdrW = stringWidth(hdr);
    const gap = Math.max(1, cardW - hdrW - clearW);
    const clearCol1 = padL0 + hdrW + gap + 1;
    registerHitbox(screenStartRow + r, clearCol1, Math.min(mainWidth, clearCol1 + clearW - 1), "clear_activity", {});
    lines[r] = fitToWidth(`${bg}${" ".repeat(padL0)}${hdr}${bg}${" ".repeat(gap)}${theme.bgSelected}${theme.fgMuted}${clearBtn}${A.reset}`, mainWidth, bg);
    r += 2;
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }

  const listMaxRows = Math.max(1, bodyHeight - r - 1);
  if (activityLog.length === 0 && r < bodyHeight - 1) {
    const emptyRow = fitToWidth(`  ${theme.fgMuted}No activity recorded yet. Send a message or refresh the mesh.${A.reset}`, inner, theme.bgInput);
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${emptyRow}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
  } else {
    const needsScroll = activityLog.length > listMaxRows;
    const maxStart = Math.max(0, activityLog.length - Math.max(1, listMaxRows - (needsScroll ? 1 : 0)));
    const startIdx = needsScroll ? Math.max(0, Math.min(scrollOffset, maxStart)) : 0;
    scrollOffset = startIdx;

    let availRows = listMaxRows;
    const hasAbove = startIdx > 0;
    if (hasAbove) availRows = Math.max(1, availRows - 1);
    let hasBelow = startIdx + availRows < activityLog.length;
    if (hasBelow && availRows > 1) availRows -= 1;
    hasBelow = startIdx + availRows < activityLog.length;

    if (hasAbove && r < bodyHeight - 1) {
      const hint = fitToWidth(`  ${theme.fgAccent}↑ ${startIdx} more above (scroll up)${A.reset}`, inner, theme.bgInput);
      registerHitbox(screenStartRow + r, padL0 + 1, Math.min(mainWidth, padL0 + cardW), "scroll_list", { delta: -3 });
      lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${hint}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
    }

    const endIdx = Math.min(activityLog.length, startIdx + availRows);
    for (let i = startIdx; i < endIdx && r < bodyHeight - 1; i++) {
      const entry = sanitizeTerminalText(activityLog[i]);
      const row = fitToWidth(`  ${theme.fgSubtle}${entry}${A.reset}`, inner, theme.bgInput);
      lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${row}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
    }

    if (hasBelow && r < bodyHeight - 1) {
      const rem = activityLog.length - endIdx;
      const hint = fitToWidth(`  ${theme.fgAccent}↓ ${rem} more below (scroll down)${A.reset}`, inner, theme.bgInput);
      registerHitbox(screenStartRow + r, padL0 + 1, Math.min(mainWidth, padL0 + cardW), "scroll_list", { delta: 3 });
      lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${hint}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
    }
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  return lines;
}

function renderSettingsView(mainWidth, bodyHeight, screenStartRow) {
  const theme = getTheme();
  const bg = theme.bgCanvas;
  const maxCardW = Math.max(24, mainWidth - 2);
  const cardW = Math.min(78, maxCardW, Math.max(Math.min(44, maxCardW), Math.floor(mainWidth * 0.80)));
  const padL0 = Math.max(0, Math.floor((mainWidth - cardW) / 2));
  const inner = Math.max(12, cardW - 2);
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  let r = 1;
  if (r < bodyHeight) {
    const hdr = `${A.bold}${theme.fgAccent}⚙ Intercom UI & Telemetry Settings${A.reset}  ${theme.fgMuted}(Click or Enter to toggle)${A.reset}`;
    lines[r] = fitToWidth(`${bg}${" ".repeat(padL0)}${hdr}`, mainWidth, bg);
    r += 2;
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }

  for (let i = 0; i < SETTINGS_OPTIONS.length && r < bodyHeight - 2; i++) {
    const opt = SETTINGS_OPTIONS[i];
    const enabled = Boolean(settings[opt.key]);
    const isSel = i === selectedSettingIndex;
    const rowBg = isSel ? theme.bgSelected : theme.bgInput;
    const cursor = isSel ? `${theme.fgAccent}›${A.reset}` : " ";
    const togglePill = enabled
      ? `${theme.bgActiveNav}${A.bold}${theme.fgOnActive} ON  ${A.reset}`
      : `${theme.bgSelected}${theme.fgMuted} OFF ${A.reset}`;

    const labelPart = ` ${cursor} ${A.bold}${theme.fgPrimary}${padEnd(opt.label, 17)}${A.reset} ${togglePill}  ${theme.fgMuted}${opt.desc}${A.reset}`;
    const content = fitToWidth(labelPart, inner, rowBg);

    registerHitbox(screenStartRow + r, padL0 + 1, Math.min(mainWidth, padL0 + cardW), "toggle_setting", { key: opt.key, index: i });
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${content}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  return lines;
}

function renderHelpView(mainWidth, bodyHeight, screenStartRow = 2) {
  const theme = getTheme();
  const bg = theme.bgCanvas;
  const compact = mainWidth < 55;
  const maxCardW = Math.max(24, mainWidth - 2);
  const cardW = Math.min(78, maxCardW, Math.max(Math.min(44, maxCardW), Math.floor(mainWidth * 0.80)));
  const padL0 = Math.max(0, Math.floor((mainWidth - cardW) / 2));
  const inner = Math.max(12, cardW - 2);
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  const closeBtn = compact || cardW < 44 ? "[×]" : "[ × Close ]";
  const closeW = stringWidth(closeBtn);

  let r = 1;
  if (r < bodyHeight) {
    const rawHdr = compact
      ? `${A.bold}${theme.fgAccent}? Shortcuts & Commands${A.reset}`
      : `${A.bold}${theme.fgAccent}? Intercom Shortcuts & Slash Commands${A.reset}`;
    const hdr = clipAnsi(rawHdr, Math.max(4, cardW - closeW - 2));
    const hdrW = stringWidth(hdr);
    const gap = Math.max(1, cardW - hdrW - closeW);
    const closeCol1 = padL0 + hdrW + gap + 1;
    registerHitbox(screenStartRow + r, closeCol1, Math.min(mainWidth, closeCol1 + closeW - 1), "close_help", {});
    lines[r] = fitToWidth(`${bg}${" ".repeat(padL0)}${hdr}${bg}${" ".repeat(gap)}${theme.bgSelected}${theme.fgAccent}${closeBtn}${A.reset}`, mainWidth, bg);
    r += 2;
  }
  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }

  const keysText = "Keys: [Tab] Tabs · [Ctrl+B] Menu · [Esc then z / Ctrl+Z] Zen · [a] Activity · [F5] Refresh · [q] Quit";
  const keysWrapped = wrapText(keysText, Math.max(10, inner - 4));
  const hasPadRow = bodyHeight >= 10;
  const footerReserve = 1 + keysWrapped.length + (hasPadRow ? 1 : 0);
  const cmdMaxRow = Math.max(r, bodyHeight - footerReserve);

  for (let i = 0; i < SLASH_COMMANDS.length; i++) {
    const sc = SLASH_COMMANDS[i];
    if (r >= cmdMaxRow) break;
    const syntaxPad = compact ? 16 : 25;
    const row = fitToWidth(`  ${A.bold}${theme.fgAccent}${padEnd(sc.syntax, syntaxPad)}${A.reset} ${theme.fgSubtle}${sc.desc}${A.reset}`, inner, theme.bgInput);
    registerHitbox(
      screenStartRow + r,
      padL0 + 1,
      Math.min(mainWidth, padL0 + cardW),
      "select_slash_command",
      { cmd: sc.cmd, syntax: sc.syntax, hasArgs: sc.hasArgs, index: i }
    );
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${row}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
  }

  if (hasPadRow && r < bodyHeight - keysWrapped.length - 1) {
    const padRow = fitToWidth("", inner, theme.bgInput);
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${padRow}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
  }

  for (let k = 0; k < keysWrapped.length && r < bodyHeight - 1; k++) {
    const prefix = k === 0 ? "  " : "        ";
    const keysLine = fitToWidth(`${prefix}${theme.fgMuted}${keysWrapped[k]}${A.reset}`, inner, theme.bgInput);
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.v}${A.reset}${keysLine}${theme.fgAccent}${B.v}${A.reset}`, mainWidth, bg);
  }
  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${theme.fgAccent}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────
//  RENDER BOTTOM BAR (Status + Lower-Corner Telemetry Stats)
// ─────────────────────────────────────────────────────────────────
function renderBottomBar(cols, bottomRow) {
  const theme = getTheme();
  const compact = cols < 60;
  const statsText = settings.showCornerStats ? formatCornerStats() : "";
  const statsW = stringWidth(statsText);
  const quitBtn = cols < 48 ? "[Q]" : "[ Quit ]";
  const quitW = stringWidth(quitBtn);
  const safeNotice = sanitizeTerminalText(lastStatusNotice);

  // Left side: status notice + [ Quit ] pill
  const quitCol1 = 2;
  registerHitbox(bottomRow, quitCol1, quitCol1 + quitW - 1, "btn_quit", {});
  const leftPart = ` ${theme.bgSelected}${theme.fgMuted}${quitBtn}${A.reset}${theme.bgFooter}  ${theme.fgMuted}${safeNotice}${A.reset}`;

  if (!statsText || (compact && cols - quitW - statsW < 10)) {
    return fitToWidth(`${theme.bgFooter}${leftPart}`, cols, theme.bgFooter);
  }

  const maxLeftW = Math.max(quitW + 2, cols - statsW - 3);
  const clippedLeft = clipAnsi(leftPart, maxLeftW);
  const gap = Math.max(1, cols - stringWidth(clippedLeft) - statsW - 1);
  return fitToWidth(`${theme.bgFooter}${clippedLeft}${theme.bgFooter}${" ".repeat(gap)}${theme.fgAccent}${statsText}${A.reset} `, cols, theme.bgFooter);
}

// ─────────────────────────────────────────────────────────────────
//  FULL FRAME RENDERER (Headless-Testable & Blessed Paint Target)
// ─────────────────────────────────────────────────────────────────
function renderViewLines(mainWidth, bodyHeight, startRow) {
  if (activeNav === 0) {
    return renderComposerPanel(mainWidth, bodyHeight, startRow, {
      centeredVertically: true,
      showHeading: !zenMode,
      headingText: "✉ Intercom"
    });
  }
  if (activeNav === 1) {
    return renderThreadAndComposer(mainWidth, bodyHeight, startRow, false);
  }
  if (activeNav === 2) {
    return renderThreadAndComposer(mainWidth, bodyHeight, startRow, true);
  }
  if (activeNav === 3) {
    return renderPeersView(mainWidth, bodyHeight, startRow);
  }
  if (activeNav === 4) {
    return renderInfoView(mainWidth, bodyHeight, startRow);
  }
  if (activeNav === 5) {
    return renderSettingsView(mainWidth, bodyHeight, startRow);
  }
  if (activeNav === 7) {
    return renderActivityView(mainWidth, bodyHeight, startRow);
  }
  return renderHelpView(mainWidth, bodyHeight, startRow);
}

function renderFrame(colsArg, rowsArg) {
  const theme = getTheme();
  const fallbackCols = (screen.cols && screen.cols > 1) ? screen.cols : ((screen.width && screen.width > 1) ? screen.width : 80);
  const fallbackRows = (screen.rows && screen.rows > 1) ? screen.rows : ((screen.height && screen.height > 1) ? screen.height : 24);
  const cols = Math.max(36, colsArg || fallbackCols);
  const rows = Math.max(12, rowsArg || fallbackRows);
  hitboxes = [];

  if (zenMode) {
    const zenLines = renderViewLines(cols, rows, 1);
    const out = [];
    for (let r = 0; r < rows; r++) {
      out.push(zenLines[r] || fitToWidth("", cols, theme.bgCanvas));
    }
    return out;
  }

  const topLine = renderTopBar(cols);
  const bodyHeight = Math.max(8, rows - 2);
  const startRow = 2;
  const maxSidebarW = Math.max(16, cols - 24);
  const sidebarW = rightSidebarOpen ? Math.min(28, maxSidebarW, Math.max(18, Math.floor(cols * 0.26))) : 0;
  const mainWidth = cols - sidebarW;

  const mainLines = renderViewLines(mainWidth, bodyHeight, startRow);
  const sidebarLines = rightSidebarOpen ? renderSidebar(sidebarW, bodyHeight, startRow, cols) : [];

  const frame = [topLine];
  for (let r = 0; r < bodyHeight; r++) {
    const leftPart = mainLines[r] || fitToWidth("", mainWidth, theme.bgCanvas);
    if (rightSidebarOpen) {
      const rightPart = sidebarLines[r] || fitToWidth("", sidebarW, theme.bgSidebar);
      frame.push(leftPart + rightPart);
    } else {
      frame.push(leftPart);
    }
  }
  frame.push(renderBottomBar(cols, rows));

  return frame.slice(0, rows);
}

// ─────────────────────────────────────────────────────────────────
//  ASYNC / MTIME-CACHED THREAD BUFFER & SCOPED WATCHER HELPERS
// ─────────────────────────────────────────────────────────────────
function getThreadCacheKey(isChannel, targetName) {
  return `${isChannel ? "channel" : "peer"}:${String(targetName || "")}`;
}

async function readAgentInboxEnvelopes(meshDir, agentName, maxFiles = 50) {
  const inboxDir = path.join(meshDir, "inbox", agentName);
  const legacyFile = path.join(meshDir, `${agentName}.json`);

  let dirStat = null;
  try {
    dirStat = await fs.promises.stat(inboxDir);
  } catch {}

  if (dirStat && dirStat.isDirectory()) {
    const dirMtime = dirStat.mtimeMs || 0;
    try {
      const files = await fs.promises.readdir(inboxDir);
      const parsedFiles = [];
      for (const f of files) {
        if (!/^\d+_[a-zA-Z0-9\-]+\.json$/.test(f)) continue;
        const sepIdx = f.indexOf("_");
        parsedFiles.push({
          file: f,
          ts: parseInt(f.slice(0, sepIdx), 10) || 0,
          idPart: f.slice(sepIdx + 1, -5)
        });
      }
      parsedFiles.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.idPart.localeCompare(b.idPart)));
      const tailFiles = parsedFiles.slice(-maxFiles);
      const envelopes = (await Promise.all(
        tailFiles.map(async ({ file }) => {
          try {
            const content = await fs.promises.readFile(path.join(inboxDir, file), "utf8");
            return JSON.parse(content);
          } catch {
            return null;
          }
        })
      )).filter(Boolean);

      if (envelopes.length > 0) {
        return { messages: envelopes, stamp: `dir:${dirMtime}:${parsedFiles.length}` };
      }
    } catch {}
  }

  try {
    const st = await fs.promises.stat(legacyFile);
    const legMtime = st.mtimeMs || 0;
    const raw = await fs.promises.readFile(legacyFile, "utf8");
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed) ? parsed.slice(-maxFiles) : [];
    return { messages, stamp: `leg:${legMtime}` };
  } catch {
    return { messages: [], stamp: dirStat ? `dir:${dirStat.mtimeMs || 0}:0` : "none:0" };
  }
}

function getSafeSelfAgent() {
  try {
    return validateAgentName(getSelfIdentity());
  } catch {
    return null;
  }
}

async function loadThreadMessages(isChannel, targetName, { force = false } = {}) {
  const cleanRaw = String(targetName || "").replace(/^[@#]/, "").trim();
  if (!cleanRaw) return [];
  const key = getThreadCacheKey(isChannel, cleanRaw);
  const meshDir = getMeshDir();

  if (isChannel) {
    const cleanCh = cleanRaw.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    const file = path.join(meshDir, "channels", `${cleanCh}.json`);
    let mtimeMs = 0;
    try {
      const st = await fs.promises.stat(file);
      mtimeMs = st.mtimeMs || 0;
    } catch {
      const cached = threadCache.get(key);
      if (!force && cached && cached.mtimeMs === 0) return cached.messages;
      threadCache.set(key, { messages: [], mtimeMs: 0, loadedAt: Date.now() });
      return [];
    }

    const cached = threadCache.get(key);
    if (!force && cached && cached.mtimeMs === mtimeMs) {
      return cached.messages;
    }

    try {
      const raw = await fs.promises.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed) ? parsed.slice(-50) : [];
      threadCache.set(key, { messages, mtimeMs, loadedAt: Date.now() });
      return messages;
    } catch {
      return cached ? cached.messages : [];
    }
  }

  let cleanAgent;
  try {
    cleanAgent = validateAgentName(cleanRaw);
  } catch {
    return [];
  }

  const cleanSelf = getSafeSelfAgent();
  const isSelfThread = Boolean(cleanSelf && cleanSelf.toLowerCase() === cleanAgent.toLowerCase());

  // Stat check for fast mtime cache hit before reading envelopes
  const statStampFor = async (agentName) => {
    const dirPath = path.join(meshDir, "inbox", agentName);
    const legPath = path.join(meshDir, `${agentName}.json`);
    let dStamp = "0";
    let lStamp = "0";
    try {
      const st = await fs.promises.stat(dirPath);
      if (st.isDirectory()) dStamp = String(st.mtimeMs || 0);
    } catch {}
    try {
      const st = await fs.promises.stat(legPath);
      lStamp = String(st.mtimeMs || 0);
    } catch {}
    return `${dStamp}:${lStamp}`;
  };

  const peerStatStamp = await statStampFor(cleanAgent);
  const selfStatStamp = (!isSelfThread && cleanSelf) ? await statStampFor(cleanSelf) : "none";
  const combinedStamp = `${peerStatStamp}|${selfStatStamp}`;

  const cached = threadCache.get(key);
  if (!force && cached && cached.mtimeMs === combinedStamp) {
    return cached.messages;
  }

  const [peerRes, selfRes] = await Promise.all([
    readAgentInboxEnvelopes(meshDir, cleanAgent, 50),
    (!isSelfThread && cleanSelf) ? readAgentInboxEnvelopes(meshDir, cleanSelf, 100) : Promise.resolve({ messages: [], stamp: "none" })
  ]);

  const peerLower = cleanAgent.toLowerCase();
  const incomingFromPeer = selfRes.messages.filter((m) => {
    if (!m) return false;
    const fromLower = String(m.from || m.sender || "").trim().toLowerCase();
    return fromLower === peerLower;
  });

  // Merge outgoing/direct messages in inbox/<selectedPeer> + incoming replies in inbox/<self> from selectedPeer
  const combined = [...peerRes.messages, ...incomingFromPeer];
  const seen = new Set();
  const deduped = [];
  for (const m of combined) {
    if (!m) continue;
    const dedupKey = m.id
      ? `id:${m.id}`
      : `sig:${m.timestamp || ""}|${m.from || m.sender || ""}|${m.message || (m.payload && m.payload.message) || m.body || ""}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    deduped.push(m);
  }

  const getMsgEpoch = (m) => {
    if (typeof m.epochMs === "number" && Number.isFinite(m.epochMs)) return m.epochMs;
    const parsed = Date.parse(m.timestamp || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  deduped.sort((a, b) => {
    const ea = getMsgEpoch(a);
    const eb = getMsgEpoch(b);
    if (ea !== eb) return ea - eb;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  const finalMsgs = deduped.slice(-25);
  threadCache.set(key, { messages: finalMsgs, mtimeMs: combinedStamp, loadedAt: Date.now() });
  return finalMsgs;
}

async function loadActiveThread(options = {}) {
  if (activeNav === 1 && selectedAgent) {
    return loadThreadMessages(false, selectedAgent, options);
  }
  if (activeNav === 2 && selectedChannel) {
    return loadThreadMessages(true, selectedChannel, options);
  }
  return [];
}

function syncWatchedInboxDir() {
  if (!watcher || isHeadlessTest) return;
  const nextAgent = selectedAgent;
  if (!nextAgent || nextAgent === watchedInboxAgent) return;
  try {
    const meshDir = getMeshDir();
    const cleanSelf = getSafeSelfAgent();
    if (watchedInboxAgent && (!cleanSelf || watchedInboxAgent.toLowerCase() !== cleanSelf.toLowerCase())) {
      watcher.unwatch(path.join(meshDir, "inbox", watchedInboxAgent));
    }
    watcher.add(path.join(meshDir, "inbox", nextAgent));
    watchedInboxAgent = nextAgent;
  } catch {}
}

// ─────────────────────────────────────────────────────────────────
//  FULL REFRESH & LIST LOADING (Dynamic Registry + Heartbeat Liveness)
// ─────────────────────────────────────────────────────────────────
async function loadListsImpl() {
  let totalUnread = 0;
  const meshDir = getMeshDir();
  const nextOnlineSet = new Set();

  try {
    const [rawPeers, activeCards] = await Promise.all([
      listActiveMailboxes({ excludeEphemeral: true }).catch(() => []),
      listActiveAgents({ includeStale: false }).catch(() => [])
    ]);

    let liveHeartbeats = [];
    try {
      const hbReg = new HeartbeatRegistry(meshDir);
      liveHeartbeats = hbReg.listLivePeers(120000);
    } catch {
      liveHeartbeats = [];
    }

    for (const card of activeCards) {
      if (card && card.name && card.status !== "OFFLINE") {
        nextOnlineSet.add(String(card.name).toLowerCase());
      }
    }
    for (const hb of liveHeartbeats) {
      if (hb && hb.agent && hb.online) {
        nextOnlineSet.add(String(hb.agent).toLowerCase());
      }
    }
    onlinePeersSet = nextOnlineSet;

    const peerMap = new Map();
    for (const p of rawPeers) {
      if (!p || !p.name) continue;
      const key = p.name.toLowerCase();
      peerMap.set(key, { name: p.name, total: p.total || 0, unread: p.unread || 0, online: nextOnlineSet.has(key) });
    }
    for (const card of activeCards) {
      if (!card || !card.name || card.status === "OFFLINE") continue;
      const key = String(card.name).toLowerCase();
      if (!peerMap.has(key)) {
        peerMap.set(key, { name: card.name, total: 0, unread: 0, online: true });
      }
    }
    for (const hb of liveHeartbeats) {
      if (!hb || !hb.agent || !hb.online) continue;
      const key = String(hb.agent).toLowerCase();
      if (!peerMap.has(key)) {
        peerMap.set(key, { name: hb.agent, total: 0, unread: 0, online: true });
      }
    }

    const cleanSelf = getSafeSelfAgent();
    const incomingUnreadByPeer = new Map();
    const incomingTotalByPeer = new Map();
    if (cleanSelf) {
      try {
        const selfDiskMsgs = readInboxSync(cleanSelf) || [];
        for (const m of selfDiskMsgs) {
          if (!m) continue;
          const sender = String(m.from || m.sender || "").trim();
          if (!sender) continue;
          const senderLower = sender.toLowerCase();
          if (senderLower === cleanSelf.toLowerCase()) continue;
          incomingTotalByPeer.set(senderLower, (incomingTotalByPeer.get(senderLower) || 0) + 1);
          if (!(m.read || (m.metadata && m.metadata.read))) {
            incomingUnreadByPeer.set(senderLower, (incomingUnreadByPeer.get(senderLower) || 0) + 1);
          }
        }
      } catch {}
    }

    const allPeers = peerMap.size > 0
      ? Array.from(peerMap.values())
      : KNOWN_DEFAULT_PEERS.map((name) => ({ name, total: 0, unread: 0, online: nextOnlineSet.has(name.toLowerCase()) }));

    agentMetaMap = new Map();
    for (const p of allPeers) {
      const pKey = p.name.toLowerCase();
      const incTotal = incomingTotalByPeer.get(pKey) || 0;
      const incUnread = incomingUnreadByPeer.get(pKey) || 0;
      let unreadCount = (p.unread || 0) + incUnread;
      const cached = threadCache.get(`peer:${p.name}`);
      if (cached && Array.isArray(cached.messages)) {
        const readInCache = cached.messages.filter((m) => Boolean(m.read || (m.metadata && m.metadata.read))).length;
        const combinedTotal = (p.total || 0) + incTotal;
        if (combinedTotal <= cached.messages.length) {
          unreadCount = Math.max(0, cached.messages.length - readInCache);
        } else {
          unreadCount = Math.max(0, unreadCount - readInCache);
        }
      }
      agentMetaMap.set(p.name, { total: (p.total || 0) + incTotal, unread: unreadCount, online: Boolean(p.online) });
      totalUnread += unreadCount;
    }
    agentList = allPeers.map((p) => p.name);
    const foundIdx = agentList.indexOf(selectedAgent);
    agentIdx = foundIdx >= 0 ? foundIdx : 0;
    if (agentList.length > 0 && !agentList.includes(selectedAgent)) {
      selectedAgent = agentList[agentIdx];
    }
    syncWatchedInboxDir();
  } catch {
    agentList = [...KNOWN_DEFAULT_PEERS];
    agentIdx = Math.max(0, Math.min(agentIdx, agentList.length - 1));
  }

  try {
    const rawCh = listChannels();
    const chMap = new Map();
    for (const c of rawCh) {
      const clean = String(c.name || "").replace(/^#+/, "").trim();
      if (!clean) continue;
      if (/^(?:test|tmp|fuzz)[-_]/i.test(clean) || /[-_]\d{10,}$/.test(clean)) continue;
      chMap.set(clean, { name: clean, total: c.total || 0 });
    }
    const allCh = chMap.size > 0
      ? Array.from(chMap.values())
      : KNOWN_DEFAULT_CHANNELS.map((name) => ({ name, total: 0 }));

    channelMetaMap = new Map();
    for (const c of allCh) {
      channelMetaMap.set(c.name, { total: c.total || 0 });
    }
    channelList = allCh.map((c) => c.name);
    const foundCh = channelList.indexOf(selectedChannel);
    channelIdx = foundCh >= 0 ? foundCh : 0;
    if (channelList.length > 0 && !channelList.includes(selectedChannel)) {
      selectedChannel = channelList[channelIdx];
    }
  } catch {
    channelList = [...KNOWN_DEFAULT_CHANNELS];
    channelIdx = Math.max(0, Math.min(channelIdx, channelList.length - 1));
  }

  let dlqLen = 0;
  try {
    const dlq = getDlq();
    dlqLen = Array.isArray(dlq) ? dlq.length : 0;
    meshInfoCache.dlq = Array.isArray(dlq) ? dlq : [];
  } catch {
    dlqLen = 0;
  }

  meshStats = {
    peers: agentList.length,
    unread: totalUnread,
    channels: channelList.length,
    dlq: dlqLen
  };
}

async function loadLists() {
  if (loadListsInFlight) return loadListsInFlight;
  loadListsInFlight = loadListsImpl().finally(() => {
    loadListsInFlight = null;
  });
  return loadListsInFlight;
}

async function refreshMeshInfo() {
  await loadLists();
  await loadActiveThread({ force: true });
  try {
    const diag = await diagnoseMesh().catch(() => ({}));
    meshInfoCache = {
      services: diag.services || {},
      mailboxes: diag.mailboxes || [],
      channels: channelList,
      dlq: getDlq(),
      updatedAt: new Date().toISOString()
    };
    lastStatusNotice = "Refreshed peers, channels & mesh health";
  } catch (err) {
    lastStatusNotice = `Refresh note: ${err.message}`;
  }
}

async function refreshOnce() {
  if (activeNav === 1 && selectedAgent && !threadCache.has(getThreadCacheKey(false, selectedAgent))) {
    await loadThreadMessages(false, selectedAgent);
  } else if (activeNav === 2 && selectedChannel && !threadCache.has(getThreadCacheKey(true, selectedChannel))) {
    await loadThreadMessages(true, selectedChannel);
  }
  const curCols = (screen.cols && screen.cols > 1) ? screen.cols : ((screen.width && screen.width > 1) ? screen.width : 80);
  const curRows = (screen.rows && screen.rows > 1) ? screen.rows : ((screen.height && screen.height > 1) ? screen.height : 24);
  const frame = renderFrame(curCols, curRows);
  try {
    mainCanvasBox.setContent(frame.join("\n"));
    screen.render();
  } catch {}
  return frame;
}

async function refresh() {
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    let lastFrame;
    do {
      refreshQueued = false;
      lastFrame = await refreshOnce();
    } while (refreshQueued);
    return lastFrame;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ─────────────────────────────────────────────────────────────────
//  SLASH COMMAND EXECUTION & MESSAGE DISPATCH (Fast-Path + Safe-Path)
// ─────────────────────────────────────────────────────────────────
async function dispatchMessage(isChannel, target, body) {
  const cleanTarget = String(target || "").replace(/^[@#]/, "").trim();
  const cleanBody = String(body || "").trim();
  if (!cleanTarget || !cleanBody) return { ok: false, reason: "empty" };
  const sender = getSelfIdentity();
  const port = getPort() || 4150;

  if (isChannel) {
    let fastSent = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/intercom/channels/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: cleanTarget, from: sender, message: cleanBody }),
        signal: AbortSignal.timeout(500)
      });
      if (res.ok) fastSent = true;
    } catch {}

    if (!fastSent) {
      sendChannelMessage(cleanTarget, sender, cleanBody);
    }

    selectedType = "channel";
    selectedChannel = cleanTarget;
    ensureTargetSubTab("channel", cleanTarget, true);
    threadCache.delete(getThreadCacheKey(true, cleanTarget));
    await loadThreadMessages(true, cleanTarget, { force: true });
    logActivity(`Broadcast → #${cleanTarget}: ${cleanBody.slice(0, 50)}`);
    lastStatusNotice = `✔ Broadcasted to #${cleanTarget}${fastSent ? " (Fast-Path)" : ""}`;
    return { ok: true, target: `#${cleanTarget}`, message: cleanBody, fastPath: fastSent };
  }

  try {
    const envelope = MessageEnvelope.create({
      sender,
      recipient: cleanTarget,
      type: "task_dispatch",
      priority: "NORMAL",
      payload: { message: cleanBody }
    });

    let deliveryMode = "Safe-Path";
    let sentFast = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/intercom/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope.toJSON()),
        signal: AbortSignal.timeout(700)
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        sentFast = true;
        deliveryMode = data.status || "DELIVERED_FAST_PATH";
      }
    } catch {}

    if (!sentFast) {
      await writeMessage(cleanTarget, envelope);
    }

    selectedType = "peer";
    selectedAgent = cleanTarget;
    ensureTargetSubTab("peer", cleanTarget, true);
    threadCache.delete(getThreadCacheKey(false, cleanTarget));
    await loadThreadMessages(false, cleanTarget, { force: true });
    logActivity(`Sent → @${cleanTarget}: ${cleanBody.slice(0, 50)}`);
    lastStatusNotice = `✔ Sent to @${cleanTarget} (${deliveryMode})`;
    return { ok: true, target: `@${cleanTarget}`, message: cleanBody, deliveryMode };
  } catch (err) {
    lastStatusNotice = `Send error: ${err.message}`;
    return { ok: false, error: err.message };
  }
}

async function markPeerInboxRead(agentName) {
  const cleanRaw = String(agentName || selectedAgent || "").replace(/^@/, "").trim();
  if (!cleanRaw) return { ok: false, count: 0 };
  let cleanAgent = cleanRaw;
  try {
    cleanAgent = validateAgentName(cleanRaw);
  } catch {
    return { ok: false, count: 0 };
  }

  let markedCount = 0;
  try {
    const diskMsgs = readInboxSync(cleanAgent) || [];
    for (const m of diskMsgs) {
      if (m && m.id && !(m.read || (m.metadata && m.metadata.read))) {
        const updated = updateDiscreteEnvelopeSync(cleanAgent, m.id, (env) => ({
          ...env,
          read: true,
          metadata: { ...(env.metadata || {}), read: true }
        }));
        if (updated) markedCount++;
      }
    }
  } catch {}

  try {
    const legacyMarked = checkAndMarkRead(cleanAgent);
    if (Array.isArray(legacyMarked)) markedCount += legacyMarked.length;
  } catch {}

  const cleanSelf = getSafeSelfAgent();
  if (cleanSelf && cleanSelf.toLowerCase() !== cleanAgent.toLowerCase()) {
    try {
      const selfDiskMsgs = readInboxSync(cleanSelf) || [];
      const targetLower = cleanAgent.toLowerCase();
      for (const m of selfDiskMsgs) {
        if (!m || !m.id) continue;
        const fromLower = String(m.from || m.sender || "").trim().toLowerCase();
        if (fromLower === targetLower && !(m.read || (m.metadata && m.metadata.read))) {
          const updated = updateDiscreteEnvelopeSync(cleanSelf, m.id, (env) => ({
            ...env,
            read: true,
            metadata: { ...(env.metadata || {}), read: true }
          }));
          if (updated) markedCount++;
        }
      }
    } catch {}
  }

  const key = getThreadCacheKey(false, cleanAgent);
  const existingCache = threadCache.get(key);
  if (existingCache && Array.isArray(existingCache.messages)) {
    const updatedMsgs = existingCache.messages.map((m) => {
      if (!m) return m;
      if (!(m.read || (m.metadata && m.metadata.read))) markedCount++;
      return {
        ...m,
        read: true,
        metadata: { ...(m.metadata || {}), read: true }
      };
    });
    threadCache.set(key, { ...existingCache, messages: updatedMsgs, loadedAt: Date.now() });
  } else {
    await loadThreadMessages(false, cleanAgent, { force: true });
  }

  const prevMeta = agentMetaMap.get(cleanAgent) || { total: 0, unread: 0, online: isPeerOnline(cleanAgent) };
  agentMetaMap.set(cleanAgent, { ...prevMeta, unread: 0 });

  let totalUnread = 0;
  for (const [, m] of agentMetaMap.entries()) totalUnread += Math.max(0, m.unread || 0);
  meshStats = { ...meshStats, unread: totalUnread };

  logActivity(`Marked @${cleanAgent} inbox read`);
  lastStatusNotice = `✓ Marked @${cleanAgent} inbox read`;
  return { ok: true, agent: cleanAgent, count: markedCount };
}

async function executeSlashCommand(rawInput) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const spaceIdx = trimmed.indexOf(" ");
  const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (cmd === "/msg" || cmd === "/m") {
    const parts = rest.split(/\s+/);
    const peer = (parts[0] || "").replace(/^@/, "");
    const text = rest.slice(parts[0]?.length || 0).trim();
    if (!peer || !text) {
      composerBuffer = "/msg ";
      composerCursor = composerBuffer.length;
      composerFocused = true;
      composerFocusZone = "input";
      slashMenuDismissed = false;
      lastStatusNotice = "Usage: /msg <peer> <text>";
      await refresh();
      return { handled: true, action: "slash_prefill", cmd: "/msg" };
    }
    const res = await dispatchMessage(false, peer, text);
    composerBuffer = "";
    composerCursor = 0;
    composerFocusZone = "input";
    await loadLists();
    await refresh();
    return { handled: true, action: "slash_msg", ...res };
  }

  if (cmd === "/channel" || cmd === "/ch") {
    const parts = rest.split(/\s+/);
    const chName = (parts[0] || "").replace(/^#/, "").trim();
    const text = rest.slice(parts[0]?.length || 0).trim();
    if (!chName) {
      composerBuffer = "/channel ";
      composerCursor = composerBuffer.length;
      composerFocused = true;
      composerFocusZone = "input";
      slashMenuDismissed = false;
      lastStatusNotice = "Usage: /channel <name> [text]";
      await refresh();
      return { handled: true, action: "slash_prefill", cmd: "/channel" };
    }
    if (!text) {
      // Quick-open channel
      const cleanCh = chName.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
      if (!channelList.includes(cleanCh)) {
        channelList.push(cleanCh);
        channelMetaMap.set(cleanCh, { total: 0 });
      }
      selectedType = "channel";
      selectedChannel = cleanCh;
      channelIdx = Math.max(0, channelList.indexOf(cleanCh));
      ensureTargetSubTab("channel", cleanCh, true);
      composerBuffer = "";
      composerCursor = 0;
      slashMenuDismissed = false;
      await loadThreadMessages(true, cleanCh, { force: true });
      lastStatusNotice = `Opened #${cleanCh}`;
      await refresh();
      return { handled: true, action: "slash_channel_open", channel: cleanCh };
    }
    const res = await dispatchMessage(true, chName, text);
    composerBuffer = "";
    composerCursor = 0;
    composerFocusZone = "input";
    await loadLists();
    await refresh();
    return { handled: true, action: "slash_channel", ...res };
  }

  // Clear prompt for non-arg slash commands
  composerBuffer = "";
  composerCursor = 0;
  composerFocusZone = "input";
  slashMenuDismissed = false;
  scrollOffset = 0;

  if (cmd === "/peers") {
    activeNav = 3;
    lastNonHelpNav = 3;
    composerFocused = false;
    lastStatusNotice = "Opened Peer Mailboxes";
  } else if (cmd === "/info" || cmd === "/health") {
    activeNav = 4;
    lastNonHelpNav = 4;
    composerFocused = false;
    lastStatusNotice = "Opened Mesh Health & Info";
  } else if (cmd === "/settings") {
    activeNav = 5;
    lastNonHelpNav = 5;
    composerFocused = false;
    lastStatusNotice = "Opened Intercom Settings";
  } else if (cmd === "/activity") {
    activeNav = 7;
    lastNonHelpNav = 7;
    composerFocused = false;
    lastStatusNotice = "Opened Activity Log";
  } else if (cmd === "/zen") {
    zenMode = !zenMode;
    lastStatusNotice = zenMode ? "Zen mode enabled" : "Zen mode disabled";
  } else if (cmd === "/read") {
    const targetPeer = rest.replace(/^@/, "") || selectedAgent;
    await markPeerInboxRead(targetPeer);
  } else if (cmd === "/refresh") {
    await refreshMeshInfo();
  } else if (cmd === "/clear") {
    if (activeNav === 1 && selectedAgent) {
      await clearInbox(selectedAgent);
      threadCache.delete(getThreadCacheKey(false, selectedAgent));
      await loadLists();
      await loadThreadMessages(false, selectedAgent, { force: true });
      lastStatusNotice = `Cleared inbox for @${selectedAgent}`;
    } else {
      lastStatusNotice = "Cleared prompt";
    }
  } else if (cmd === "/menu") {
    rightSidebarOpen = !rightSidebarOpen;
    lastStatusNotice = rightSidebarOpen ? "Menu opened" : "Menu closed";
  } else if (cmd === "/new") {
    openNewSubTab();
    await loadActiveThread();
  } else if (cmd === "/help") {
    if (activeNav !== 6) lastNonHelpNav = activeNav;
    activeNav = 6;
    composerFocused = false;
    lastStatusNotice = "Opened Intercom Help";
  } else {
    lastStatusNotice = `Unknown command: ${cmd}`;
  }

  await refresh();
  return { handled: true, action: "slash_executed", cmd };
}

async function doSend() {
  const val = String(composerBuffer || "").trim();
  if (!val) {
    composerFocused = true;
    await refresh();
    return { handled: true, action: "empty" };
  }

  if (val.startsWith("/")) {
    return executeSlashCommand(val);
  }

  let isChannel = selectedType === "channel";
  let target = isChannel ? selectedChannel : selectedAgent;
  let body = val;

  if (val.startsWith("@")) {
    const parts = val.split(/\s+/);
    target = parts[0].slice(1);
    body = val.slice(parts[0].length).trim();
    isChannel = false;
  } else if (val.startsWith("#")) {
    const parts = val.split(/\s+/);
    target = parts[0].slice(1);
    body = val.slice(parts[0].length).trim();
    isChannel = true;
  }

  if (!body) return { handled: true, action: "empty_body" };

  const res = await dispatchMessage(isChannel, target, body);
  composerBuffer = "";
  composerCursor = 0;
  slashMenuDismissed = false;
  await loadLists();
  await refresh();
  return res;
}

// ─────────────────────────────────────────────────────────────────
//  HITBOX ACTION DISPATCH
// ─────────────────────────────────────────────────────────────────
let lastHitTime = 0;
let lastHitKey  = "";

async function executeHitAction(hit) {
  if (!hit) return;
  const p = hit.payload || {};

  switch (hit.action) {
    case "nav":
      if ((p.index ?? 0) === 6 && activeNav !== 6) lastNonHelpNav = activeNav;
      activeNav = p.index ?? 0;
      if (activeNav !== 6) lastNonHelpNav = activeNav;
      targetDropdownOpen = false;
      scrollOffset = 0;
      selectedMessageIndex = -1;
      if (activeNav === 0) {
        activeSubTabIndex = 0;
        ensureActiveSubTabVisible = true;
      } else if (activeNav === 1) {
        selectedType = "peer";
        if (selectedAgent) ensureTargetSubTab("peer", selectedAgent, true);
      } else if (activeNav === 2) {
        selectedType = "channel";
        if (selectedChannel) ensureTargetSubTab("channel", selectedChannel, true);
      }
      syncComposerFocusForNav(activeNav);
      await loadActiveThread();
      await refresh();
      break;

    case "open_activity":
      if (activeNav !== 6) lastNonHelpNav = activeNav;
      activeNav = 7;
      lastNonHelpNav = 7;
      scrollOffset = 0;
      targetDropdownOpen = false;
      composerFocused = false;
      await refresh();
      break;

    case "clear_activity":
      activityLog.length = 0;
      scrollOffset = 0;
      lastStatusNotice = "Activity log cleared";
      await refresh();
      break;

    case "close_help":
      activeNav = lastNonHelpNav !== 6 ? lastNonHelpNav : 0;
      syncComposerFocusForNav(activeNav);
      lastStatusNotice = "Closed Help";
      await loadActiveThread();
      await refresh();
      break;

    case "scroll_subtabs":
      subTabScrollOffset = Math.max(
        0,
        Math.min(Math.max(0, subTabs.length - 1), subTabScrollOffset + (p.delta || 1))
      );
      ensureActiveSubTabVisible = false;
      await refresh();
      break;

    case "scroll_list":
      scrollOffset = Math.max(0, scrollOffset + (p.delta || 0));
      await refresh();
      break;

    case "toggle_peer_filter":
      peerFilterActive = !peerFilterActive;
      peerFilterCursor = peerFilterQuery.length;
      scrollOffset = 0;
      await refresh();
      break;

    case "focus_peer_filter":
      peerFilterActive = true;
      peerFilterCursor = peerFilterQuery.length;
      await refresh();
      break;

    case "clear_peer_filter":
      peerFilterQuery = "";
      peerFilterCursor = 0;
      peerFilterActive = false;
      scrollOffset = 0;
      await refresh();
      break;

    case "new_channel_prompt":
      composerBuffer = "/channel ";
      composerCursor = composerBuffer.length;
      composerFocused = true;
      composerFocusZone = "input";
      slashMenuDismissed = true;
      lastStatusNotice = "Enter channel name after /channel and press Enter";
      await refresh();
      break;

    case "btn_mark_read":
      await markPeerInboxRead(p.agent || selectedAgent);
      await refresh();
      break;

    case "select_message":
      selectedMessageIndex = typeof p.index === "number" ? p.index : -1;
      await refresh();
      break;

    case "reply_message": {
      const rawFrom = String(p.from || "").trim();
      const fromLower = rawFrom.toLowerCase();
      const selfLower = getSelfIdentity().toLowerCase();
      const isSelfSender = fromLower === selfLower || fromLower === "operator" || fromLower === "exdelegate";
      const targetName = (isSelfSender && selectedAgent) ? selectedAgent : (rawFrom || selectedAgent || "operator");
      const replyTarget = sanitizeTerminalText(targetName).replace(/^@/, "");
      composerBuffer = `@${replyTarget} `;
      composerCursor = composerBuffer.length;
      composerFocused = true;
      composerFocusZone = "input";
      slashMenuDismissed = true;
      lastStatusNotice = `Replying to @${replyTarget}`;
      await refresh();
      break;
    }

    case "forward_message": {
      const fwdFrom = sanitizeTerminalText(p.from || "peer");
      const fwdBody = sanitizeTerminalText(String(p.body || "").trim());
      composerBuffer = `/msg  [Fwd from @${fwdFrom}]: ${fwdBody}`;
      composerCursor = 5;
      composerFocused = true;
      composerFocusZone = "input";
      slashMenuDismissed = true;
      lastStatusNotice = "Type recipient after /msg and press Enter to forward";
      await refresh();
      break;
    }

    case "select_agent":
      selectedAgent = p.name;
      agentIdx = p.index ?? Math.max(0, agentList.indexOf(p.name));
      selectedType = "peer";
      activeNav = 1;
      lastNonHelpNav = 1;
      targetDropdownOpen = false;
      ensureTargetSubTab("peer", p.name, true);
      await loadThreadMessages(false, p.name);
      await refresh();
      break;

    case "select_channel":
      selectedChannel = p.name;
      channelIdx = p.index ?? Math.max(0, channelList.indexOf(p.name));
      selectedType = "channel";
      activeNav = 2;
      lastNonHelpNav = 2;
      targetDropdownOpen = false;
      ensureTargetSubTab("channel", p.name, true);
      await loadThreadMessages(true, p.name);
      await refresh();
      break;

    case "switch_subtab":
      switchSubTab(p.index ?? p.id);
      targetDropdownOpen = false;
      await loadActiveThread();
      await refresh();
      break;

    case "close_subtab":
      closeSubTab(p.index ?? p.id);
      targetDropdownOpen = false;
      await loadActiveThread();
      await refresh();
      break;

    case "new_subtab":
      openNewSubTab();
      targetDropdownOpen = false;
      await loadActiveThread();
      await refresh();
      break;

    case "toggle_sidebar":
      rightSidebarOpen = !rightSidebarOpen;
      lastStatusNotice = rightSidebarOpen ? "Sidebar opened" : "Sidebar closed";
      await refresh();
      break;

    case "toggle_target_dropdown":
      targetDropdownOpen = !targetDropdownOpen;
      if (targetDropdownOpen) {
        slashMenuDismissed = true;
      }
      await refresh();
      break;

    case "select_target_option":
      if (p.type === "peer") {
        selectedType = "peer";
        selectedAgent = p.name;
        agentIdx = p.index ?? Math.max(0, agentList.indexOf(p.name));
        syncWatchedInboxDir();
        if (activeNav === 1 || activeNav === 2) {
          ensureTargetSubTab("peer", p.name, true);
          await loadThreadMessages(false, p.name);
        }
      } else if (p.type === "channel") {
        selectedType = "channel";
        selectedChannel = p.name;
        channelIdx = p.index ?? Math.max(0, channelList.indexOf(p.name));
        if (activeNav === 1 || activeNav === 2) {
          ensureTargetSubTab("channel", p.name, true);
          await loadThreadMessages(true, p.name);
        }
      }
      targetDropdownOpen = false;
      composerFocused = activeNav <= 2;
      if (composerFocused) composerFocusZone = "input";
      await refresh();
      break;

    case "select_slash_command": {
      const cmd = p.cmd || "";
      if (p.hasArgs) {
        if (activeNav > 2) {
          activeNav = lastNonHelpNav <= 2 ? lastNonHelpNav : 0;
          if (activeNav === 0) activeSubTabIndex = 0;
        }
        composerBuffer = `${cmd} `;
        composerCursor = composerBuffer.length;
        composerFocused = true;
        composerFocusZone = "input";
        slashMenuDismissed = false;
        await refresh();
      } else {
        await executeSlashCommand(cmd);
      }
      break;
    }

    case "toggle_setting":
      if (p.key && Object.prototype.hasOwnProperty.call(settings, p.key)) {
        settings[p.key] = !settings[p.key];
        if (typeof p.index === "number") selectedSettingIndex = p.index;
        lastStatusNotice = `${p.key}: ${settings[p.key] ? "ON" : "OFF"}`;
        await refresh();
      }
      break;

    case "btn_send":
      await doSend();
      break;

    case "btn_clear":
      if (composerBuffer.length > 0) {
        composerBuffer = "";
        composerCursor = 0;
        slashMenuDismissed = false;
        composerFocusZone = "input";
        composerFocused = true;
        lastStatusNotice = "Prompt cleared";
      } else if (activeNav === 1 && selectedAgent) {
        await clearInbox(selectedAgent);
        threadCache.delete(getThreadCacheKey(false, selectedAgent));
        await loadLists();
        await loadThreadMessages(false, selectedAgent, { force: true });
        logActivity(`Cleared inbox for @${selectedAgent}`);
        lastStatusNotice = `Cleared inbox for @${selectedAgent}`;
      }
      await refresh();
      break;

    case "btn_refresh":
      targetDropdownOpen = false;
      await refreshMeshInfo();
      await refresh();
      break;

    case "btn_quit":
      cleanExit();
      break;

    case "focus_compose":
      composerFocused = true;
      composerFocusZone = "input";
      await refresh();
      break;
  }
}

function handleHit(row, col) {
  const now = Date.now();
  const key = `${row}:${col}`;
  if (now - lastHitTime < 60 && lastHitKey === key) {
    return;
  }
  lastHitTime = now;
  lastHitKey = key;

  const hit = hitTest(row, col);
  if (hit) {
    executeHitAction(hit);
  } else if (targetDropdownOpen) {
    targetDropdownOpen = false;
    refresh();
  }
}

// ─────────────────────────────────────────────────────────────────
//  KEYBOARD HANDLER (Unified Readline, Sub-Tabs, Zen Mode, Esc Blur)
// ─────────────────────────────────────────────────────────────────
async function handleKey(str, key = {}) {
  if (!key) return { handled: false };

  // Global quit (Ctrl+C always; q/Q when not editing/focused in composer or peer filter)
  if ((key.ctrl && key.name === "c") || (!composerBuffer && !targetDropdownOpen && !composerFocused && !peerFilterActive && (str === "q" || str === "Q"))) {
    cleanExit();
    return { handled: true, action: "quit" };
  }

  // Zen / Focus Mode toggle (Ctrl+Z always; z/Z when composer & peer filter are unfocused)
  if (
    (key.ctrl && key.name === "z") ||
    str === "\x1a" ||
    (!composerFocused && !peerFilterActive && !targetDropdownOpen && !composerBuffer && (str === "z" || str === "Z"))
  ) {
    zenMode = !zenMode;
    lastStatusNotice = zenMode ? "Zen mode enabled (press z or Esc to exit)" : "Zen mode disabled";
    await refresh();
    return { handled: true, action: "toggle_zen", zenMode };
  }

  // Activity Log quick toggle when composer & peer filter are unfocused
  if (!composerFocused && !peerFilterActive && !targetDropdownOpen && !composerBuffer && (str === "a" || str === "A")) {
    activeNav = activeNav === 7 ? 0 : 7;
    if (activeNav !== 6) lastNonHelpNav = activeNav;
    scrollOffset = 0;
    syncComposerFocusForNav(activeNav);
    lastStatusNotice = activeNav === 7 ? "Opened Activity Log" : "Returned Home";
    await refresh();
    return { handled: true, action: "toggle_activity", activeNav };
  }

  // Ctrl+B: Toggle Collapsible Right Sidebar
  if ((key.ctrl && key.name === "b") || str === "\x02") {
    rightSidebarOpen = !rightSidebarOpen;
    lastStatusNotice = rightSidebarOpen ? "Sidebar opened" : "Sidebar closed";
    await refresh();
    return { handled: true, action: "toggle_sidebar", rightSidebarOpen };
  }

  // F5: Manual Refresh
  if (key.name === "f5") {
    await refreshMeshInfo();
    await refresh();
    return { handled: true, action: "refresh" };
  }

  // Target Selector Dropdown active navigation
  if (targetDropdownOpen) {
    const items = getTargetDropdownItems();
    if (key.name === "escape") {
      targetDropdownOpen = false;
      await refresh();
      return { handled: true, action: "close_target_dropdown" };
    }
    if (key.name === "up") {
      targetDropdownIndex = Math.max(0, targetDropdownIndex - 1);
      await refresh();
      return { handled: true, action: "target_dropdown_move" };
    }
    if (key.name === "down") {
      targetDropdownIndex = Math.min(Math.max(0, items.length - 1), targetDropdownIndex + 1);
      await refresh();
      return { handled: true, action: "target_dropdown_move" };
    }
    if (key.name === "return" || key.name === "tab") {
      const sel = items[targetDropdownIndex];
      if (sel) {
        if (sel.type === "action") {
          await executeHitAction({ action: "btn_refresh", payload: {} });
        } else {
          await executeHitAction({ action: "select_target_option", payload: sel });
        }
      }
      return { handled: true, action: "target_dropdown_select" };
    }
  }

  // Slash-Command Dropdown active navigation
  if (isSlashMenuVisible()) {
    const matches = getFilteredSlashCommands(composerBuffer);

    if (key.name === "escape") {
      slashMenuDismissed = true;
      await refresh();
      return { handled: true, action: "close_slash_menu" };
    }
    if (key.name === "up") {
      slashSelectedIndex = Math.max(0, slashSelectedIndex - 1);
      await refresh();
      return { handled: true, action: "slash_move" };
    }
    if (key.name === "down") {
      slashSelectedIndex = Math.min(Math.max(0, matches.length - 1), slashSelectedIndex + 1);
      await refresh();
      return { handled: true, action: "slash_move" };
    }
    if (key.name === "tab") {
      const sel = matches[slashSelectedIndex] || matches[0];
      if (sel) {
        composerBuffer = sel.hasArgs ? `${sel.cmd} ` : sel.cmd;
        composerCursor = composerBuffer.length;
        await refresh();
      }
      return { handled: true, action: "slash_complete" };
    }
    if (key.name === "return") {
      const sel = matches[slashSelectedIndex] || matches[0];
      if (sel) {
        if (sel.hasArgs) {
          composerBuffer = `${sel.cmd} `;
          composerCursor = composerBuffer.length;
          await refresh();
          return { handled: true, action: "slash_prefill" };
        }
        return executeSlashCommand(sel.cmd);
      }
    }
  }

  // Settings View Up/Down/Enter/Space navigation
  if (activeNav === 5 && !composerBuffer) {
    if (key.name === "up") {
      selectedSettingIndex = Math.max(0, selectedSettingIndex - 1);
      await refresh();
      return { handled: true, action: "setting_move" };
    }
    if (key.name === "down") {
      selectedSettingIndex = Math.min(SETTINGS_OPTIONS.length - 1, selectedSettingIndex + 1);
      await refresh();
      return { handled: true, action: "setting_move" };
    }
    if (key.name === "return" || key.name === "space") {
      const opt = SETTINGS_OPTIONS[selectedSettingIndex];
      if (opt) {
        await executeHitAction({ action: "toggle_setting", payload: { key: opt.key, index: selectedSettingIndex } });
        return { handled: true, action: "setting_toggled" };
      }
    }
  }

  // Peers View Filter & Navigation
  if (activeNav === 3) {
    const filtered = getFilteredAgents();
    if (!peerFilterActive && str === "/") {
      peerFilterActive = true;
      peerFilterCursor = peerFilterQuery.length;
      await refresh();
      return { handled: true, action: "peer_filter_open" };
    }
    if (peerFilterActive) {
      if (key.name === "escape") {
        if (peerFilterQuery.length > 0) {
          peerFilterQuery = "";
          peerFilterCursor = 0;
          scrollOffset = 0;
        } else {
          peerFilterActive = false;
        }
        await refresh();
        return { handled: true, action: "peer_filter_escape" };
      }
      if (key.name === "up" || key.name === "down") {
        if (filtered.length > 0) {
          const delta = key.name === "up" ? -1 : 1;
          const curF = Math.max(0, filtered.indexOf(selectedAgent));
          const nextF = Math.max(0, Math.min(filtered.length - 1, curF + delta));
          selectedAgent = filtered[nextF];
          const realIdx = agentList.indexOf(selectedAgent);
          if (realIdx >= 0) agentIdx = realIdx;
          if (nextF < scrollOffset) scrollOffset = nextF;
          else if (nextF >= scrollOffset + 8) scrollOffset = nextF - 7;
        }
        await refresh();
        return { handled: true, action: "peer_move" };
      }
      if (key.name === "return") {
        if (filtered.length > 0) {
          const target = filtered.includes(selectedAgent) ? selectedAgent : filtered[0];
          await executeHitAction({ action: "select_agent", payload: { name: target, index: agentList.indexOf(target) } });
          return { handled: true, action: "open_peer_from_list" };
        }
        return { handled: false };
      }
      const fState = { value: peerFilterQuery, cursor: peerFilterCursor };
      if (applyReadlineKey(fState, str, key)) {
        peerFilterQuery = fState.value;
        peerFilterCursor = fState.cursor;
        scrollOffset = 0;
        await refresh();
        return { handled: true, action: "peer_filter_edit" };
      }
    }
  }

  // Composer Action Row Focus Ring (To:, Send, Clear)
  if (activeNav <= 2 && composerFocusZone !== "input") {
    const ring = ["target", "send", "clear", "input"];
    const rowRing = ["target", "send", "clear"];
    if (key.name === "tab") {
      const cur = ring.indexOf(composerFocusZone);
      const next = key.shift
        ? (cur <= 0 ? "input" : ring[cur - 1])
        : ring[(cur + 1) % ring.length];
      composerFocusZone = next;
      composerFocused = next === "input";
      await refresh();
      return { handled: true, action: "focus_ring_move", zone: composerFocusZone };
    }
    if (key.name === "left" || key.name === "right") {
      const cur = Math.max(0, rowRing.indexOf(composerFocusZone));
      const delta = key.name === "left" ? -1 : 1;
      composerFocusZone = rowRing[(cur + delta + rowRing.length) % rowRing.length];
      await refresh();
      return { handled: true, action: "focus_ring_move", zone: composerFocusZone };
    }
    if (key.name === "up") {
      composerFocusZone = "input";
      composerFocused = true;
      await refresh();
      return { handled: true, action: "focus_ring_move", zone: "input" };
    }
    if (key.name === "return" || key.name === "space") {
      const zone = composerFocusZone;
      if (zone === "target") await executeHitAction({ action: "toggle_target_dropdown", payload: {} });
      else if (zone === "send") await executeHitAction({ action: "btn_send", payload: {} });
      else if (zone === "clear") await executeHitAction({ action: "btn_clear", payload: {} });
      return { handled: true, action: "focus_ring_activate", zone };
    }
    if (key.name === "escape") {
      composerFocusZone = "input";
      composerFocused = true;
      await refresh();
      return { handled: true, action: "focus_ring_exit" };
    }
  }

  // Tab key: autocomplete @/#, step composer focus ring, or cycle Row-1 sub-tabs
  if (key.name === "tab") {
    if (composerFocused && composerBuffer.startsWith("@")) {
      const idx = (agentList.indexOf(selectedAgent) + 1) % Math.max(1, agentList.length);
      selectedAgent = agentList[idx] || "antigravity";
      composerBuffer = `@${selectedAgent} `;
      composerCursor = composerBuffer.length;
      await refresh();
      return { handled: true, action: "autocomplete_peer" };
    }
    if (composerFocused && composerBuffer.startsWith("#")) {
      const idx = (channelList.indexOf(selectedChannel) + 1) % Math.max(1, channelList.length);
      selectedChannel = channelList[idx] || "general";
      composerBuffer = `#${selectedChannel} `;
      composerCursor = composerBuffer.length;
      await refresh();
      return { handled: true, action: "autocomplete_channel" };
    }
    if (activeNav <= 2 && composerFocusZone === "input") {
      if (key.shift) {
        composerFocusZone = "clear";
        composerFocused = false;
        await refresh();
        return { handled: true, action: "focus_ring_move", zone: "clear" };
      }
      if (composerBuffer.length > 0 || subTabs.length <= 1) {
        composerFocusZone = "target";
        composerFocused = false;
        await refresh();
        return { handled: true, action: "focus_ring_move", zone: "target" };
      }
    }
    if (key.shift) prevSubTab();
    else nextSubTab();
    await loadActiveThread();
    await refresh();
    return { handled: true, action: "switch_subtab" };
  }

  // Enter on Peers view opens selected peer thread; Enter on composer views sends
  if (key.name === "return") {
    if (activeNav === 3) {
      const filtered = getFilteredAgents();
      const target = (filtered.length > 0 && (filtered.includes(agentList[agentIdx]) ? agentList[agentIdx] : filtered[0])) || null;
      if (target) {
        await executeHitAction({ action: "select_agent", payload: { name: target, index: agentList.indexOf(target) } });
        return { handled: true, action: "open_peer_from_list" };
      }
      return { handled: false };
    }
    if (composerFocused && activeNav <= 2) {
      return doSend();
    }
    return { handled: false };
  }

  // Escape: clear buffer, close sidebar, exit Zen, clear message selection, or blur composer
  if (key.name === "escape") {
    if (composerBuffer.length > 0) {
      composerBuffer = "";
      composerCursor = 0;
      slashMenuDismissed = false;
      await refresh();
      return { handled: true, action: "clear_prompt" };
    }
    if (rightSidebarOpen) {
      rightSidebarOpen = false;
      await refresh();
      return { handled: true, action: "close_sidebar" };
    }
    if (zenMode) {
      zenMode = false;
      await refresh();
      return { handled: true, action: "exit_zen" };
    }
    if (selectedMessageIndex >= 0) {
      selectedMessageIndex = -1;
      await refresh();
      return { handled: true, action: "clear_message_selection" };
    }
    if (composerFocused) {
      composerFocused = false;
      lastStatusNotice = "Composer unfocused · Press q to quit, z for Zen, or click input";
      await refresh();
      return { handled: true, action: "blur_compose" };
    }
    return { handled: false };
  }

  // Shift+Up / Shift+Down (or Alt+Up / Alt+Down) on Thread views selects messages
  if ((key.shift || key.meta) && (key.name === "up" || key.name === "down") && (activeNav === 1 || activeNav === 2)) {
    const isCh = activeNav === 2;
    const cacheEntry = threadCache.get(getThreadCacheKey(isCh, isCh ? selectedChannel : selectedAgent));
    const recent = (cacheEntry && Array.isArray(cacheEntry.messages)) ? cacheEntry.messages.slice(-25) : [];
    if (recent.length > 0) {
      if (selectedMessageIndex < 0) {
        selectedMessageIndex = recent.length - 1;
      } else {
        const delta = key.name === "up" ? -1 : 1;
        selectedMessageIndex = Math.max(0, Math.min(recent.length - 1, selectedMessageIndex + delta));
      }
      await refresh();
      return { handled: true, action: "select_message", selectedMessageIndex };
    }
  }

  // Quick Reply (r) / Forward (f) on selected message when composer unfocused
  if (!composerFocused && !composerBuffer && selectedMessageIndex >= 0 && (activeNav === 1 || activeNav === 2) && (str === "r" || str === "R" || str === "f" || str === "F")) {
    const isCh = activeNav === 2;
    const cacheEntry = threadCache.get(getThreadCacheKey(isCh, isCh ? selectedChannel : selectedAgent));
    const recent = (cacheEntry && Array.isArray(cacheEntry.messages)) ? cacheEntry.messages.slice(-25) : [];
    const m = recent[selectedMessageIndex];
    if (m) {
      const from = sanitizeTerminalText(m.from || m.sender || selectedAgent);
      const body = sanitizeTerminalText(String(m.message || (m.payload && m.payload.message) || m.body || "").trim());
      const action = (str === "r" || str === "R") ? "reply_message" : "forward_message";
      await executeHitAction({ action, payload: { index: selectedMessageIndex, from, body } });
      return { handled: true, action };
    }
  }

  // Up/Down when on Inbox/Channels/Peers/Activity and prompt empty -> scroll or navigate
  if ((key.name === "up" || key.name === "down") && composerBuffer.length === 0) {
    const delta = key.name === "up" ? -1 : 1;
    if (activeNav === 3) {
      const filtered = getFilteredAgents();
      if (!peerFilterQuery && agentList.length > 0) {
        agentIdx = Math.max(0, Math.min(agentList.length - 1, agentIdx + delta));
        selectedAgent = agentList[agentIdx];
        if (agentIdx < scrollOffset) scrollOffset = agentIdx;
        else if (agentIdx >= scrollOffset + 8) scrollOffset = agentIdx - 7;
        await refresh();
        return { handled: true, action: "peer_move" };
      }
      if (filtered.length > 0) {
        const curF = Math.max(0, filtered.indexOf(selectedAgent));
        const nextF = Math.max(0, Math.min(filtered.length - 1, curF + delta));
        selectedAgent = filtered[nextF];
        const realIdx = agentList.indexOf(selectedAgent);
        if (realIdx >= 0) agentIdx = realIdx;
        if (nextF < scrollOffset) scrollOffset = nextF;
        else if (nextF >= scrollOffset + 8) scrollOffset = nextF - 7;
        await refresh();
        return { handled: true, action: "peer_move" };
      }
    }
    if (activeNav === 7) {
      scrollOffset = Math.max(0, scrollOffset + delta);
      await refresh();
      return { handled: true, action: "scroll" };
    }
    if (activeNav === 1 || activeNav === 2) {
      scrollOffset = Math.max(0, scrollOffset - delta * 2);
      await refresh();
      return { handled: true, action: "scroll" };
    }
  }

  // Readline composer editing (ONLY when on composer views and composer is focused)
  if (!composerFocused || activeNav > 2) {
    return { handled: false };
  }

  const bufState = { value: composerBuffer, cursor: composerCursor };
  if (applyReadlineKey(bufState, str, key)) {
    const changed = bufState.value !== composerBuffer;
    composerBuffer = bufState.value;
    composerCursor = bufState.cursor;
    composerFocused = true;
    composerFocusZone = "input";
    if (changed) {
      slashMenuDismissed = false;
      slashSelectedIndex = 0;
    }
    await refresh();
    return { handled: true, action: "edit" };
  }

  return { handled: false };
}

// ─────────────────────────────────────────────────────────────────
//  MOUSE EVENT DISPATCH (Single SGR 1006 Stream Decoder)
// ─────────────────────────────────────────────────────────────────
const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function parseSgrSequence(str) {
  const matches = String(str || "").matchAll(sgrRegex);
  const results = [];
  for (const m of matches) {
    results.push({
      rawBtn: parseInt(m[1], 10),
      col: parseInt(m[2], 10),
      row: parseInt(m[3], 10),
      isRelease: m[4] === "m"
    });
  }
  return results;
}

function handleMouseWheel(rawBtn) {
  const isListView = activeNav === 3 || activeNav === 7;
  if (rawBtn === 64) {
    scrollOffset = isListView ? Math.max(0, scrollOffset - 3) : scrollOffset + 3;
    return refresh();
  }
  if (rawBtn === 65) {
    scrollOffset = isListView ? scrollOffset + 3 : Math.max(0, scrollOffset - 3);
    return refresh();
  }
  return Promise.resolve();
}

if (screen.program && !isHeadlessTest) {
  screen.program.on("data", (data) => {
    const str = typeof data === "string" ? data : data.toString("utf8");
    const events = parseSgrSequence(str);
    for (const ev of events) {
      if (!ev.isRelease && ev.rawBtn === 0) {
        handleHit(ev.row, ev.col);
      } else if (!ev.isRelease && (ev.rawBtn === 64 || ev.rawBtn === 65)) {
        handleMouseWheel(ev.rawBtn);
      }
    }
  });
}

screen.on("keypress", (str, key) => {
  if (!isHeadlessTest) {
    handleKey(str, key).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────
//  SCOPED LIVE WATCHER (150ms Debounce + Single-Flight Guard)
// ─────────────────────────────────────────────────────────────────
function scheduleWatcherRefresh() {
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
  watchDebounceTimer = setTimeout(async () => {
    watchDebounceTimer = null;
    try {
      await loadLists();
      await loadActiveThread({ force: true });
      await refresh();
    } catch {}
  }, 150);
}

if (!isHeadlessTest) {
  try {
    const meshDir = getMeshDir();
    const watchTargets = [
      path.join(meshDir, "channels"),
      path.join(meshDir, "dlq")
    ];
    if (selectedAgent) {
      watchedInboxAgent = selectedAgent;
      watchTargets.push(path.join(meshDir, "inbox", selectedAgent));
    }
    const cleanSelf = getSafeSelfAgent();
    if (cleanSelf && cleanSelf !== selectedAgent) {
      watchTargets.push(path.join(meshDir, "inbox", cleanSelf));
    }
    watcher = chokidar.watch(watchTargets, {
      persistent:    true,
      ignoreInitial: true,
      depth:         1,
      usePolling:    false,
      ignored:       /(^|[\/\\])(\.tmp|locks|ledger|read-state)|\.tmp$/i
    });
    watcher.on("all", scheduleWatcherRefresh);
  } catch {}

  (async () => {
    await refreshMeshInfo();
    await refresh();
  })();
}

// ─────────────────────────────────────────────────────────────────
//  EXPORTS FOR TESTING & HEADLESS HARNESSES
// ─────────────────────────────────────────────────────────────────
module.exports = {
  NAV_TABS,
  SLASH_COMMANDS,
  SETTINGS_OPTIONS,
  sanitizeTerminalText,
  stripAnsi,
  stringWidth,
  wrapText,
  renderCursorText,
  getTheme,
  isPeerOnline,
  loadThreadMessages,
  registerHitbox,
  hitTest,
  getHitboxes: () => hitboxes,
  clearHitboxes: () => { hitboxes = []; },
  handleHit,
  executeHitAction,
  handleKey,
  handleMouseWheel,
  markPeerInboxRead,
  doSend,
  executeSlashCommand,
  renderTopBar,
  renderSidebar,
  renderFrame,
  fitToWidth,
  getFilteredSlashCommands,
  getTargetDropdownItems,
  formatCornerStats,
  getSubTabs: () => subTabs.map((t) => ({ ...t })),
  switchSubTab,
  closeSubTab,
  openNewSubTab,
  nextSubTab,
  prevSubTab,
  loadLists,
  refreshMeshInfo,
  refresh,
  screen,
  sidebarBox,
  contentBox,
  composeInput,
  getState: () => ({
    activeNav,
    activeView: activeNav === 7 ? "activity" : (NAV_TABS[activeNav] || "Home").toLowerCase(),
    rightSidebarOpen,
    sidebarOpen: rightSidebarOpen,
    zenMode,
    selectedType,
    selectedAgent,
    selectedChannel,
    agentList,
    channelList,
    agentIdx,
    channelIdx,
    subTabs: subTabs.map((t) => ({ ...t })),
    activeSubTabIndex,
    subTabScrollOffset,
    composerBuffer,
    composerCursor,
    composerFocused,
    composerFocusZone,
    targetDropdownOpen,
    targetDropdownIndex,
    slashMenuOpen: isSlashMenuVisible(),
    slashSelectedIndex,
    settings: { ...settings },
    selectedSettingIndex,
    scrollOffset,
    selectedMessageIndex,
    peerFilterActive,
    peerFilterQuery,
    lastStatusNotice,
    activityLog: [...activityLog],
    meshStats: { ...meshStats }
  }),
  setState: (patch = {}) => {
    if (patch.activeNav !== undefined) {
      activeNav = patch.activeNav;
      if (activeNav !== 6) lastNonHelpNav = activeNav;
      if (patch.composerFocused === undefined) {
        syncComposerFocusForNav(activeNav);
      }
    }
    if (patch.rightSidebarOpen !== undefined) rightSidebarOpen = Boolean(patch.rightSidebarOpen);
    if (patch.sidebarOpen !== undefined) rightSidebarOpen = Boolean(patch.sidebarOpen);
    if (patch.zenMode !== undefined) zenMode = Boolean(patch.zenMode);
    if (patch.selectedType !== undefined) selectedType = patch.selectedType;
    if (patch.selectedAgent !== undefined) selectedAgent = patch.selectedAgent;
    if (patch.selectedChannel !== undefined) selectedChannel = patch.selectedChannel;
    if (patch.agentList !== undefined) agentList = [...patch.agentList];
    if (patch.channelList !== undefined) channelList = [...patch.channelList];
    if (patch.agentIdx !== undefined) agentIdx = patch.agentIdx;
    if (patch.channelIdx !== undefined) channelIdx = patch.channelIdx;
    if (patch.subTabs !== undefined) subTabs = patch.subTabs.map((t) => ({ ...t }));
    if (patch.activeSubTabIndex !== undefined) {
      activeSubTabIndex = patch.activeSubTabIndex;
      ensureActiveSubTabVisible = true;
    }
    if (patch.subTabScrollOffset !== undefined) subTabScrollOffset = patch.subTabScrollOffset;
    if (patch.composerBuffer !== undefined) {
      composerBuffer = String(patch.composerBuffer);
      composerCursor = composerBuffer.length;
      slashMenuDismissed = false;
    }
    if (patch.composerCursor !== undefined) composerCursor = patch.composerCursor;
    if (patch.composerFocused !== undefined) composerFocused = Boolean(patch.composerFocused);
    if (patch.composerFocusZone !== undefined) composerFocusZone = String(patch.composerFocusZone);
    if (patch.targetDropdownOpen !== undefined) targetDropdownOpen = Boolean(patch.targetDropdownOpen);
    if (patch.targetDropdownIndex !== undefined) targetDropdownIndex = patch.targetDropdownIndex;
    if (patch.slashMenuDismissed !== undefined) slashMenuDismissed = Boolean(patch.slashMenuDismissed);
    if (patch.slashSelectedIndex !== undefined) slashSelectedIndex = patch.slashSelectedIndex;
    if (patch.settings !== undefined) settings = { ...settings, ...patch.settings };
    if (patch.selectedSettingIndex !== undefined) selectedSettingIndex = patch.selectedSettingIndex;
    if (patch.scrollOffset !== undefined) scrollOffset = patch.scrollOffset;
    if (patch.selectedMessageIndex !== undefined) selectedMessageIndex = patch.selectedMessageIndex;
    if (patch.peerFilterActive !== undefined) peerFilterActive = Boolean(patch.peerFilterActive);
    if (patch.peerFilterQuery !== undefined) {
      peerFilterQuery = String(patch.peerFilterQuery);
      peerFilterCursor = peerFilterQuery.length;
    }
    if (patch.agentMeta !== undefined) {
      agentMetaMap = new Map(Object.entries(patch.agentMeta));
    }
    if (patch.lastStatusNotice !== undefined) lastStatusNotice = String(patch.lastStatusNotice);
    if (patch.onlinePeers !== undefined) {
      onlinePeersSet = new Set(Array.from(patch.onlinePeers).map((n) => String(n).toLowerCase()));
    }
    if (patch.activityLog !== undefined) {
      activityLog.length = 0;
      for (const entry of patch.activityLog) activityLog.push(String(entry));
    }
    if (patch.threadMessages !== undefined) {
      for (const [k, msgs] of Object.entries(patch.threadMessages)) {
        threadCache.set(k, { messages: Array.isArray(msgs) ? msgs : [], mtimeMs: Date.now(), loadedAt: Date.now() });
      }
    }
    if (patch.meshStats !== undefined) meshStats = { ...meshStats, ...patch.meshStats };
  },
  sgrRegex,
  parseSgrSequence,
  destroyScreen
};
