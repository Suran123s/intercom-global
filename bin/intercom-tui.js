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

const { PassThrough } = require("stream");
const blessed  = require("blessed");
const chokidar = require("chokidar");

const {
  listActiveMailboxes,
  readInbox,
  clearInbox,
  sendChannelMessage,
  readChannel,
  listChannels,
  writeMessage
} = require("../src/core/mesh");
const { diagnoseMesh } = require("../src/controllers/autowake");
const { getDlq }       = require("../src/core/dlq");
const { MESH_DIR, PORT } = require("../src/config");

// ─────────────────────────────────────────────────────────────────
//  ANSI colour constants (deep-dark charcoal palette #0d1117)
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
  bgCursor:     "\x1b[46m"          // cyan block cursor
};

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
  { cmd: "/msg",      syntax: "/msg <peer> <text>",     desc: "Message an agent peer directly",                  hasArgs: true },
  { cmd: "/channel",  syntax: "/channel <name> <text>", desc: "Broadcast to a topic channel",                    hasArgs: true },
  { cmd: "/peers",    syntax: "/peers",                 desc: "Open active Peer Mailboxes directory",            hasArgs: false },
  { cmd: "/info",     syntax: "/info",                  desc: "Open Intercom Mesh Health & System Info",         hasArgs: false },
  { cmd: "/settings", syntax: "/settings",              desc: "Toggle UI/UX & Telemetry settings",               hasArgs: false },
  { cmd: "/refresh",  syntax: "/refresh",               desc: "Refresh peers, channels & mesh health manually",  hasArgs: false },
  { cmd: "/clear",    syntax: "/clear",                 desc: "Clear current inbox or prompt",                   hasArgs: false },
  { cmd: "/menu",     syntax: "/menu",                  desc: "Toggle right-side sidebar menu",                  hasArgs: false },
  { cmd: "/new",      syntax: "/new",                   desc: "Open new conversation sub-tab",                   hasArgs: false },
  { cmd: "/help",     syntax: "/help",                  desc: "Show Intercom shortcuts & slash commands",        hasArgs: false }
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
let activeNav          = 0;          // 0=Home, 1=Inbox, 2=Channels, 3=Peers, 4=Info, 5=Settings, 6=Help
let rightSidebarOpen   = false;      // Collapsed by default (appears on RIGHT when toggled)
let selectedType       = "peer";     // "peer" | "channel"
let selectedAgent      = "antigravity";
let selectedChannel    = "general";
let agentList          = [...KNOWN_DEFAULT_PEERS];
let channelList        = [...KNOWN_DEFAULT_CHANNELS];
let agentMetaMap       = new Map();  // name -> { total, unread }
let channelMetaMap     = new Map();  // name -> { total }
let agentIdx           = 0;
let channelIdx         = 0;

let subTabs = [
  { id: "home",             kind: "home",    target: null,          label: "✦ Home",       closable: false },
  { id: "peer:antigravity", kind: "peer",    target: "antigravity", label: "@antigravity", closable: true },
  { id: "channel:general",  kind: "channel", target: "general",     label: "#general",     closable: true }
];
let activeSubTabIndex  = 0;

let composerBuffer     = "";
let composerCursor     = 0;
let composerFocused    = true;

let targetDropdownOpen  = false;
let targetDropdownIndex = 0;

let slashSelectedIndex = 0;
let slashMenuDismissed = false;

let settings = {
  showCornerStats:    true,
  readReceipts:       true,
  showTimestamps:     true,
  darkTheme:          true,
  sidebarDefaultOpen: false
};
let selectedSettingIndex = 0;

let scrollOffset       = 0;
let lastStatusNotice   = "Pure Mesh Messaging · Press / for commands";
let meshStats          = { peers: KNOWN_DEFAULT_PEERS.length, unread: 0, channels: KNOWN_DEFAULT_CHANNELS.length, dlq: 0 };
let meshInfoCache      = { services: {}, mailboxes: [], channels: [], dlq: [], updatedAt: null };
const activityLog      = [];

function logActivity(text) {
  const ts = new Date().toLocaleTimeString();
  activityLog.unshift(`[${ts}] ${text}`);
  if (activityLog.length > 50) activityLog.pop();
}

function getCanvasBg() {
  return settings.darkTheme !== false ? A.bgCanvas : "\x1b[48;5;236m";
}

// ─────────────────────────────────────────────────────────────────
//  String measurement & ANSI-safe clipping helpers
// ─────────────────────────────────────────────────────────────────
const ANSI_TOKEN_REGEX = /(\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g;

function stripAnsi(str) {
  return String(str || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function charDisplayWidth(code) {
  if (code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )) {
    return 2;
  }
  return 1;
}

function stringWidth(str) {
  const plain = stripAnsi(str);
  let w = 0;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    // Handle surrogate pairs (emoji etc.) as width 2
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < plain.length) {
      w += 2;
      i++;
    } else {
      w += charDisplayWidth(code);
    }
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
    for (let i = 0; i < plain.length; i++) {
      const code = plain.charCodeAt(i);
      let ch = plain[i];
      let w;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < plain.length) {
        ch += plain[i + 1];
        i++;
        w = 2;
      } else {
        w = charDisplayWidth(code);
      }
      if (vis + w > maxCols) return false;
      out += ch;
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

function fitToWidth(str, width, bg = "") {
  const targetW = Math.max(0, width || 0);
  if (targetW === 0) return "";
  const s = String(str || "");
  const vLen = stringWidth(s);
  if (vLen === targetW) return bg ? `${bg}${s}${A.reset}` : s;
  if (vLen < targetW) {
    const padded = s + " ".repeat(targetW - vLen);
    return bg ? `${bg}${padded}${A.reset}` : padded;
  }
  const clipped = clipAnsi(s, targetW);
  const clippedW = stringWidth(clipped);
  const tail = clippedW < targetW ? " ".repeat(targetW - clippedW) : "";
  return bg ? `${bg}${clipped}${bg}${tail}${A.reset}` : `${clipped}${tail}`;
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
    for (const w of words) {
      if (!cur) {
        if (stringWidth(w) <= safeW) {
          cur = w;
        } else {
          // Hard split overly long token
          let chunk = "";
          for (const ch of w) {
            if (stringWidth(chunk + ch) > safeW) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          cur = chunk;
        }
      } else if (stringWidth(cur + " " + w) <= safeW) {
        cur += " " + w;
      } else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.length > 0 ? lines : [""];
}

// ─────────────────────────────────────────────────────────────────
//  Readline / Emacs Line Editing & Cursor Rendering
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

function applyReadlineKey(bufState, str, key = {}) {
  const val = String(bufState.value || "");
  if (bufState.cursor === undefined || bufState.cursor > val.length) {
    bufState.cursor = val.length;
  }
  const pos = bufState.cursor;

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
  // Left / Right / Delete / Backspace
  if (key.name === "left") {
    bufState.cursor = Math.max(0, pos - 1);
    return true;
  }
  if (key.name === "right") {
    bufState.cursor = Math.min(val.length, pos + 1);
    return true;
  }
  if (key.name === "delete") {
    if (pos < val.length) {
      bufState.value = val.slice(0, pos) + val.slice(pos + 1);
    }
    return true;
  }
  if (key.name === "backspace") {
    if (pos > 0) {
      bufState.value = val.slice(0, pos - 1) + val.slice(pos);
      bufState.cursor = pos - 1;
    }
    return true;
  }

  // Printable characters
  if (str && !key.ctrl && !key.meta && !str.startsWith("\x1b")) {
    const clean = str.replace(/[\x00-\x1f\x7f]/g, "");
    if (clean) {
      bufState.value = val.slice(0, pos) + clean + val.slice(pos);
      bufState.cursor = pos + clean.length;
      return true;
    }
  }
  return false;
}

function renderCursorText(text, cursorPos, maxLen, isActive, placeholder = "") {
  const val = String(text || "");
  if (!val && !isActive) {
    return `${A.gray}${clipAnsi(placeholder, maxLen)}${A.reset}`;
  }
  if (!val && isActive) {
    const ph = clipAnsi(placeholder, Math.max(0, maxLen - 1));
    return `${A.bgCursor}${A.black} ${A.reset}${A.bgInput}${A.gray}${ph}${A.reset}`;
  }
  const pos = Math.max(0, Math.min(cursorPos ?? val.length, val.length));
  if (!isActive) {
    const vis = val.length > maxLen ? "..." + val.slice(val.length - maxLen + 3) : val;
    return `${A.white}${vis}${A.reset}`;
  }
  let start = 0;
  if (pos >= maxLen - 2) {
    start = Math.max(0, pos - maxLen + 3);
  }
  const visible = val.slice(start, start + maxLen);
  const relPos = pos - start;
  const before = visible.slice(0, relPos);
  const atCursor = visible[relPos] || " ";
  const after = visible.slice(relPos + 1);
  return `${A.white}${before}${A.reset}${A.bgCursor}${A.black}${atCursor}${A.reset}${A.bgInput}${A.white}${after}${A.reset}`;
}

// ─────────────────────────────────────────────────────────────────
//  Hitbox registry (populated during each render)
// ─────────────────────────────────────────────────────────────────
let hitboxes = []; // { row, endRow, startCol, endCol, action, payload }

function registerHitbox(row, startCol, endCol, action, payload = {}, endRow = row) {
  hitboxes.push({ row, endRow, startCol, endCol, action, payload });
}

function hitTest(row, col) {
  // Scan backwards so top-most overlays (dropdowns) match before underlying surfaces
  for (let i = hitboxes.length - 1; i >= 0; i--) {
    const hb = hitboxes[i];
    const maxRow = hb.endRow || hb.row;
    if (row >= hb.row && row <= maxRow && col >= hb.startCol && col <= hb.endCol) {
      return hb;
    }
  }
  return null;
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
  process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  if (screen.program && typeof screen.program.setMouse === "function") {
    try {
      screen.program.setMouse({ sgrMouse: true, vt200Mouse: true, cellMotion: true, allMotion: true }, true);
    } catch {}
  }
}

function disableMouseTracking() {
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l");
}

if (!isHeadlessTest) {
  enableMouseTracking();
}

function cleanExit() {
  disableMouseTracking();
  try { screen.destroy(); } catch {}
  process.exit(0);
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
    if (kind === "peer") {
      selectedType = "peer";
      selectedAgent = target;
      const pIdx = agentList.indexOf(target);
      if (pIdx >= 0) agentIdx = pIdx;
      activeNav = 1; // Inbox
    } else if (kind === "channel") {
      selectedType = "channel";
      selectedChannel = target;
      const cIdx = channelList.indexOf(target);
      if (cIdx >= 0) channelIdx = cIdx;
      activeNav = 2; // Channels
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
  const tab = subTabs[idx];
  scrollOffset = 0;
  if (!tab || tab.kind === "home") {
    activeNav = 0;
  } else if (tab.kind === "peer") {
    selectedType = "peer";
    selectedAgent = tab.target || selectedAgent;
    const pIdx = agentList.indexOf(selectedAgent);
    if (pIdx >= 0) agentIdx = pIdx;
    activeNav = 1;
  } else if (tab.kind === "channel") {
    selectedType = "channel";
    selectedChannel = tab.target || selectedChannel;
    const cIdx = channelList.indexOf(selectedChannel);
    if (cIdx >= 0) channelIdx = cIdx;
    activeNav = 2;
  }
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
  if (!String(composerBuffer || "").startsWith("/")) return false;
  return getFilteredSlashCommands(composerBuffer).length > 0;
}

function getTargetDropdownItems() {
  const items = [];
  for (let i = 0; i < agentList.length; i++) {
    const name = agentList[i];
    const meta = agentMetaMap.get(name) || { total: 0, unread: 0 };
    items.push({
      type: "peer",
      name,
      index: i,
      label: `@${name}`,
      unread: meta.unread || 0,
      online: name === "antigravity" || name === "opencode" || name === "coordinator"
    });
  }
  for (let i = 0; i < channelList.length; i++) {
    const name = channelList[i];
    const meta = channelMetaMap.get(name) || { total: 0 };
    items.push({
      type: "channel",
      name,
      index: i,
      label: `#${name}`,
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
  const row = 1;
  const menuText = rightSidebarOpen ? "[ ☰ Menu · Open ]" : "[ ☰ Menu ]";
  const menuW = stringWidth(menuText);
  const menuStartCol = Math.max(2, cols - menuW);
  const menuEndCol = menuStartCol + menuW - 1;

  // Build sub-tabs left-to-right within available left area
  const maxLeftCols = Math.max(18, menuStartCol - 3);
  let leftPlainCol = 2; // 1-based start after 1 leading space
  let leftRendered = " ";

  for (let i = 0; i < subTabs.length; i++) {
    const tab = subTabs[i];
    const isActive = i === activeSubTabIndex && (activeNav === 0 || activeNav === 1 || activeNav === 2);
    const pillBg = isActive ? A.bgActiveNav : A.bgSelected;
    const pillFg = isActive ? `${A.bold}${A.white}` : A.softWhite;

    if (!tab.closable) {
      const text = `[ ${tab.label} ]`;
      const w = stringWidth(text);
      if (leftPlainCol + w > maxLeftCols) break;
      registerHitbox(row, leftPlainCol, leftPlainCol + w - 1, "switch_subtab", { index: i, id: tab.id });
      leftRendered += `${pillBg}${pillFg}${text}${A.reset}${A.bgHeader} `;
      leftPlainCol += w + 1;
    } else {
      const mainPart = `[ ${tab.label} `;
      const closePart = `× ]`;
      const mainW = stringWidth(mainPart);
      const closeW = stringWidth(closePart);
      if (leftPlainCol + mainW + closeW > maxLeftCols) continue;

      registerHitbox(row, leftPlainCol, leftPlainCol + mainW - 1, "switch_subtab", { index: i, id: tab.id });
      registerHitbox(row, leftPlainCol + mainW, leftPlainCol + mainW + closeW - 1, "close_subtab", { index: i, id: tab.id });

      leftRendered += `${pillBg}${pillFg}${mainPart}${A.gray}${closePart}${A.reset}${A.bgHeader} `;
      leftPlainCol += mainW + closeW + 1;
    }
  }

  // [ + New ] button
  const newText = "[ + New ]";
  const newW = stringWidth(newText);
  if (leftPlainCol + newW <= maxLeftCols) {
    registerHitbox(row, leftPlainCol, leftPlainCol + newW - 1, "new_subtab", {});
    leftRendered += `${A.bgSelected}${A.cyan}${newText}${A.reset}${A.bgHeader}`;
    leftPlainCol += newW;
  }

  // Gap between left sub-tabs and right [ ☰ Menu ]
  const gapW = Math.max(1, menuStartCol - leftPlainCol);
  registerHitbox(row, menuStartCol, menuEndCol, "toggle_sidebar", {});
  const menuBg = rightSidebarOpen ? A.bgActiveNav : A.bgSelected;
  const menuFg = rightSidebarOpen ? `${A.bold}${A.white}` : A.cyan;
  const menuStyled = `${menuBg}${menuFg}${menuText}${A.reset}`;

  const line = `${A.bgHeader}${leftRendered}${A.bgHeader}${" ".repeat(gapW)}${menuStyled}${A.bgHeader} `;
  return fitToWidth(line, cols, A.bgHeader);
}

// ─────────────────────────────────────────────────────────────────
//  RENDER COLLAPSIBLE RIGHT-SIDE SIDEBAR (Hidden by Default)
// ─────────────────────────────────────────────────────────────────
function renderSidebar(widthOpt, heightOpt, startRow = 2, colsOpt) {
  const cols = Math.max(80, colsOpt || screen.cols || screen.width || 80);
  const rows = Math.max(24, screen.rows || 24);
  const sW = widthOpt || Math.min(28, Math.max(22, Math.floor(cols * 0.26)));
  const sH = heightOpt || Math.max(18, rows - 2);

  if (!rightSidebarOpen) {
    try {
      sidebarBox.hide();
      sidebarBox.setContent("");
    } catch {}
    return [];
  }

  const sidebarStartCol = cols - sW + 1;
  const sidebarEndCol = cols;
  const inner = Math.max(10, sW - 2);
  const lines = [];

  // Top border
  lines.push(`${A.bgSidebar}${A.dim}${A.cyan}${B.tl}${B.h} ${A.bold}${A.white}MENU${A.reset}${A.bgSidebar}${A.dim}${A.cyan} ${B.h.repeat(Math.max(0, inner - 7))}${B.tr}${A.reset}`);

  // Vertical categories: Home, Inbox, Channels, Peers, Info, Settings, Help
  for (let i = 0; i < NAV_TABS.length && lines.length < sH - 2; i++) {
    const label = NAV_TABS[i];
    const isActive = i === activeNav;
    const screenRow = startRow + lines.length;
    registerHitbox(screenRow, sidebarStartCol, sidebarEndCol, "nav", { index: i, label });

    const indicator = isActive ? `${A.cyan}›${A.reset}` : " ";
    const bg = isActive ? A.bgActiveNav : A.bgSidebar;
    const pill = isActive
      ? `${A.bold}${A.white}[ ${label} ]${A.reset}`
      : `${A.softWhite}[ ${label} ]${A.reset}`;
    const rawContent = ` ${indicator} ${pill}`;
    lines.push(
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}${bg}` +
      fitToWidth(rawContent, inner, bg) +
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}`
    );
  }

  // Peers section
  if (lines.length < sH - 3) {
    lines.push(
      `${A.bgSidebar}${A.dim}${A.cyan}${B.vl}${B.h} ${A.bold}${A.white}PEERS${A.reset}${A.bgSidebar}${A.dim}${A.cyan} ${B.h.repeat(Math.max(0, inner - 8))}${B.vr}${A.reset}`
    );
  }

  for (let i = 0; i < agentList.length && lines.length < sH - 3; i++) {
    const name = agentList[i];
    const isSelected = name === selectedAgent && (activeNav === 1 || selectedType === "peer");
    const screenRow = startRow + lines.length;
    registerHitbox(screenRow, sidebarStartCol, sidebarEndCol, "select_agent", { name, index: i });

    const online = name === "antigravity" || name === "opencode" || name === "coordinator";
    const dot = online ? `${A.green}●${A.reset}` : `${A.gray}○${A.reset}`;
    const indicator = isSelected ? `${A.cyan}›${A.reset}` : " ";
    const meta = agentMetaMap.get(name);
    const unread = meta && meta.unread > 0 ? ` ${A.yellow}(${meta.unread})${A.reset}` : "";
    const bg = isSelected ? A.bgSelected : A.bgSidebar;
    const nameFmt = isSelected ? `${A.bold}${A.white}${name}${A.reset}` : `${A.gray}${name}${A.reset}`;
    const rowContent = ` ${indicator} ${dot} ${nameFmt}${unread}`;

    lines.push(
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}${bg}` +
      fitToWidth(rowContent, inner, bg) +
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}`
    );
  }

  // Channels section
  if (lines.length < sH - 2) {
    lines.push(
      `${A.bgSidebar}${A.dim}${A.cyan}${B.vl}${B.h} ${A.bold}${A.white}CHANNELS${A.reset}${A.bgSidebar}${A.dim}${A.cyan} ${B.h.repeat(Math.max(0, inner - 11))}${B.vr}${A.reset}`
    );
  }

  for (let i = 0; i < channelList.length && lines.length < sH - 1; i++) {
    const name = channelList[i];
    const isSelected = name === selectedChannel && (activeNav === 2 || selectedType === "channel");
    const screenRow = startRow + lines.length;
    registerHitbox(screenRow, sidebarStartCol, sidebarEndCol, "select_channel", { name, index: i });

    const indicator = isSelected ? `${A.magenta}›${A.reset}` : " ";
    const bg = isSelected ? A.bgSelected : A.bgSidebar;
    const nameFmt = isSelected ? `${A.bold}${A.white}#${name}${A.reset}` : `${A.magenta}#${name}${A.reset}`;
    const rowContent = ` ${indicator} ${nameFmt}`;

    lines.push(
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}${bg}` +
      fitToWidth(rowContent, inner, bg) +
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}`
    );
  }

  // Fill remaining rows
  while (lines.length < sH - 1) {
    lines.push(
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgSidebar}${" ".repeat(inner)}${A.dim}${A.cyan}${B.v}${A.reset}`
    );
  }

  // Bottom border
  lines.push(`${A.bgSidebar}${A.dim}${A.cyan}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`);

  try {
    sidebarBox.width = sW;
    sidebarBox.setContent(lines.join("\n"));
  } catch {}

  return lines.slice(0, sH);
}

// ─────────────────────────────────────────────────────────────────
//  OVERLAY DROPDOWN BUILDERS (Target Selector & `/` Slash Commands)
// ─────────────────────────────────────────────────────────────────
function buildSlashDropdownBox(boxW) {
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
  lines.push(`${A.bgDropdown}${A.cyan}${B.tl}${B.h}${A.bold}${A.white}${title}${A.reset}${A.bgDropdown}${A.cyan}${B.h.repeat(Math.max(0, inner - stringWidth(title) - 1))}${B.tr}${A.reset}`);

  for (let i = 0; i < visible.length; i++) {
    const item = visible[i];
    const absIdx = startIdx + i;
    const isSel = absIdx === clampedIdx;
    const rowBg = isSel ? A.bgActiveNav : A.bgDropdown;
    const prefix = isSel ? `${A.cyan}›${A.reset}` : " ";
    const cmdText = `${A.bold}${isSel ? A.white : A.cyan}${item.syntax}${A.reset}`;
    const descText = `${A.gray} — ${item.desc}${A.reset}`;
    const rowInner = fitToWidth(` ${prefix} ${cmdText}${descText}`, inner, rowBg);
    lines.push({
      line: `${A.bgDropdown}${A.cyan}${B.v}${A.reset}${rowInner}${A.bgDropdown}${A.cyan}${B.v}${A.reset}`,
      action: "select_slash_command",
      payload: { cmd: item.cmd, syntax: item.syntax, hasArgs: item.hasArgs, index: absIdx }
    });
  }

  lines.push(`${A.bgDropdown}${A.cyan}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`);
  return lines;
}

function buildTargetDropdownBox(dropW, maxBoxRows = 18) {
  const items = getTargetDropdownItems();
  const inner = Math.max(20, dropW - 2);
  const clampedIdx = Math.max(0, Math.min(targetDropdownIndex, items.length - 1));
  targetDropdownIndex = clampedIdx;

  const peerItems = items.filter((it) => it.type === "peer");
  const chItems = items.filter((it) => it.type === "channel");
  const actItems = items.filter((it) => it.type === "action");

  // Reserve room for Channels & [ ↻ Refresh ] + headers/borders so Channels never clip on busy meshes
  const maxChannelsShow = Math.min(chItems.length, 4);
  const chromeRows = 2 + (peerItems.length > 0 ? 1 : 0) + (maxChannelsShow > 0 ? 1 : 0) + (actItems.length > 0 ? 1 : 0);
  const peerBudget = Math.max(3, Math.min(peerItems.length, maxBoxRows - chromeRows - maxChannelsShow - actItems.length));

  let peerStart = 0;
  if (clampedIdx < peerItems.length && clampedIdx >= peerBudget) {
    peerStart = Math.min(peerItems.length - peerBudget, clampedIdx - peerBudget + 1);
  }
  const visibleItems = [
    ...peerItems.slice(peerStart, peerStart + peerBudget),
    ...chItems.slice(0, maxChannelsShow),
    ...actItems
  ];

  const lines = [];
  const title = " Select Target ";
  lines.push(`${A.bgDropdown}${A.cyan}${B.tl}${B.h}${A.bold}${A.white}${title}${A.reset}${A.bgDropdown}${A.cyan}${B.h.repeat(Math.max(0, inner - stringWidth(title) - 1))}${B.tr}${A.reset}`);

  let addedPeersHeader = false;
  let addedChannelsHeader = false;

  for (const it of visibleItems) {
    if (it.type === "peer" && !addedPeersHeader) {
      addedPeersHeader = true;
      const moreTag = peerItems.length > peerBudget ? ` (${peerStart + 1}-${peerStart + peerBudget}/${peerItems.length})` : "";
      lines.push(`${A.bgDropdown}${A.cyan}${B.v}${A.reset}${fitToWidth(` ${A.dim}${A.bold}PEERS${moreTag}${A.reset}`, inner, A.bgDropdown)}${A.bgDropdown}${A.cyan}${B.v}${A.reset}`);
    } else if (it.type === "channel" && !addedChannelsHeader) {
      addedChannelsHeader = true;
      lines.push(`${A.bgDropdown}${A.cyan}${B.v}${A.reset}${fitToWidth(` ${A.dim}${A.bold}CHANNELS${A.reset}`, inner, A.bgDropdown)}${A.bgDropdown}${A.cyan}${B.v}${A.reset}`);
    } else if (it.type === "action") {
      lines.push(`${A.bgDropdown}${A.cyan}${B.vl}${B.h.repeat(inner)}${B.vr}${A.reset}`);
    }

    const globalIdx = items.indexOf(it);
    const isSel = globalIdx === clampedIdx;
    const rowBg = isSel ? A.bgActiveNav : A.bgDropdown;
    const marker = isSel ? `${A.cyan}›${A.reset}` : " ";
    let rowText = "";
    if (it.type === "peer") {
      const dot = it.online ? `${A.green}●${A.reset}` : `${A.gray}○${A.reset}`;
      const badge = it.unread > 0 ? ` ${A.yellow}[${it.unread}]${A.reset}` : "";
      rowText = ` ${marker} ${dot} ${isSel ? `${A.bold}${A.white}` : A.softWhite}${it.label}${A.reset}${badge}`;
    } else if (it.type === "channel") {
      rowText = ` ${marker} ${isSel ? `${A.bold}${A.white}` : A.magenta}${it.label}${A.reset}`;
    } else {
      rowText = ` ${marker} ${A.bold}${A.cyan}[ ${it.label} ]${A.reset}`;
    }

    lines.push({
      line: `${A.bgDropdown}${A.cyan}${B.v}${A.reset}${fitToWidth(rowText, inner, rowBg)}${A.bgDropdown}${A.cyan}${B.v}${A.reset}`,
      action: it.type === "action" ? "btn_refresh" : "select_target_option",
      payload: it
    });
  }

  lines.push(`${A.bgDropdown}${A.cyan}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`);
  return lines;
}

// Overlay helper that writes centered/positioned box lines onto canvas lines and registers hitboxes
function overlayBoxOntoLines(canvasLines, startRowIdx, screenStartRow, leftCol0, boxEntries) {
  for (let i = 0; i < boxEntries.length; i++) {
    const r = startRowIdx + i;
    if (r < 0 || r >= canvasLines.length) continue;
    const entry = boxEntries[i];
    const lineStr = typeof entry === "string" ? entry : entry.line;
    const lineW = stringWidth(lineStr);
    const padL = " ".repeat(Math.max(0, leftCol0));
    const existingW = stringWidth(canvasLines[r]);
    const bg = getCanvasBg();
    const rightRemain = Math.max(0, existingW - leftCol0 - lineW);
    canvasLines[r] = `${bg}${padL}${lineStr}${bg}${" ".repeat(rightRemain)}${A.reset}`;

    if (typeof entry === "object" && entry.action) {
      registerHitbox(
        screenStartRow + r,
        leftCol0 + 1,
        leftCol0 + lineW,
        entry.action,
        entry.payload || {}
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  CENTERED COMPOSER BLOCK RENDERER
// ─────────────────────────────────────────────────────────────────
function renderComposerPanel(mainWidth, availableHeight, screenStartRow, options = {}) {
  const centeredVertically = Boolean(options.centeredVertically);
  const headingText = options.headingText || "✉ Intercom";
  const subHeadingText = options.subHeadingText || "";
  const bg = getCanvasBg();

  const boxW = Math.min(74, Math.max(38, Math.floor(mainWidth * 0.72)));
  const leftPad0 = Math.max(1, Math.floor((mainWidth - boxW) / 2));
  const boxInnerW = boxW - 2;

  const targetLabel = selectedType === "channel" ? `#${selectedChannel}` : `@${selectedAgent}`;
  const targetBtnText = `To: [ ${targetLabel} ▾ ]`;
  const sendBtnText = "[ ↵ Send ]";
  const clearBtnText = "[ Clear ]";

  const showHeading = Boolean(options.showHeading);
  const baseBlockRows = (showHeading ? 2 : 0) + 3 + 1 + (showHeading ? 1 : 0); // heading+gap, 3-row box, controls, hint

  // Check active dropdowns
  const showSlash = isSlashMenuVisible();
  const showTargetDrop = !showSlash && targetDropdownOpen;
  const slashEntries = showSlash ? buildSlashDropdownBox(boxW) : [];
  const dropW = Math.min(boxW, 38);
  const targetEntries = showTargetDrop ? buildTargetDropdownBox(dropW, Math.max(10, availableHeight - 1)) : [];

  const lines = Array.from({ length: availableHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  let composerStartRow = 0;
  if (centeredVertically) {
    const extraH = showSlash ? Math.min(slashEntries.length, 6) : (showTargetDrop ? Math.min(targetEntries.length, 8) : 0);
    const totalNeeded = baseBlockRows + (extraH > 0 ? 1 : 0);
    composerStartRow = Math.max(0, Math.floor((availableHeight - totalNeeded - Math.floor(extraH / 2)) / 2));
  } else {
    composerStartRow = Math.max(0, availableHeight - baseBlockRows);
  }

  let curR = composerStartRow;

  // 1. Optional Centered Heading above composer
  if (showHeading && curR < availableHeight) {
    const fullTitle = subHeadingText
      ? `${A.bold}${A.cyan}${headingText}${A.reset}  ${A.gray}·  ${subHeadingText}${A.reset}`
      : `${A.bold}${A.cyan}${headingText}${A.reset}  ${A.gray}·  Pure Mesh Messaging${A.reset}`;
    const titleW = stringWidth(fullTitle);
    const titlePad = Math.max(0, Math.floor((mainWidth - titleW) / 2));
    lines[curR] = fitToWidth(`${bg}${" ".repeat(titlePad)}${fullTitle}`, mainWidth, bg);
    curR += 2; // 1 blank breathing row
  }

  // 2. Composer Input Box (3 rows)
  const boxTopRow = curR;
  if (curR < availableHeight) {
    const borderColor = composerFocused ? A.cyan : A.darkGray;
    const labelStr = ` ${targetLabel} `;
    const dashes = Math.max(1, boxInnerW - stringWidth(labelStr) - 1);
    const topLine = `${A.bgInput}${borderColor}${B.tl}${B.h}${A.bold}${A.white}${labelStr}${A.reset}${A.bgInput}${borderColor}${B.h.repeat(dashes)}${B.tr}${A.reset}`;
    lines[curR] = fitToWidth(`${bg}${" ".repeat(leftPad0)}${topLine}`, mainWidth, bg);
    curR++;
  }

  if (curR < availableHeight) {
    const borderColor = composerFocused ? A.cyan : A.darkGray;
    const promptPrefix = ` ${A.cyan}›${A.reset}${A.bgInput} `;
    const prefixW = stringWidth(promptPrefix);
    const inputAvail = Math.max(8, boxInnerW - prefixW - 1);
    const placeholder = `Message ${targetLabel} or type / for commands...`;
    const cursorView = renderCursorText(composerBuffer, composerCursor, inputAvail, composerFocused, placeholder);
    const innerContent = fitToWidth(`${promptPrefix}${cursorView}`, boxInnerW, A.bgInput);
    const midLine = `${A.bgInput}${borderColor}${B.v}${A.reset}${innerContent}${A.bgInput}${borderColor}${B.v}${A.reset}`;
    lines[curR] = fitToWidth(`${bg}${" ".repeat(leftPad0)}${midLine}`, mainWidth, bg);
    curR++;
  }

  if (curR < availableHeight) {
    const borderColor = composerFocused ? A.cyan : A.darkGray;
    const botLine = `${A.bgInput}${borderColor}${B.bl}${B.h.repeat(boxInnerW)}${B.br}${A.reset}`;
    lines[curR] = fitToWidth(`${bg}${" ".repeat(leftPad0)}${botLine}`, mainWidth, bg);
    // Register hitbox for composer box
    registerHitbox(
      screenStartRow + boxTopRow,
      leftPad0 + 1,
      leftPad0 + boxW,
      "focus_compose",
      {},
      screenStartRow + curR
    );
    curR++;
  }

  // 3. Controls Row: To: [ @target ▾ ]   [ ↵ Send ]   [ Clear ]
  const controlsRowIdx = curR;
  if (curR < availableHeight) {
    const targetCol1 = leftPad0 + 1;
    const targetW = stringWidth(targetBtnText);
    const sendCol1 = targetCol1 + targetW + 2;
    const sendW = stringWidth(sendBtnText);
    const clearCol1 = sendCol1 + sendW + 2;
    const clearW = stringWidth(clearBtnText);

    const screenCtrlRow = screenStartRow + curR;
    registerHitbox(screenCtrlRow, targetCol1, targetCol1 + targetW - 1, "toggle_target_dropdown", {});
    registerHitbox(screenCtrlRow, sendCol1, sendCol1 + sendW - 1, "btn_send", {});
    registerHitbox(screenCtrlRow, clearCol1, clearCol1 + clearW - 1, "btn_clear", {});

    const targetBg = targetDropdownOpen ? A.bgActiveNav : A.bgSelected;
    const targetStyled = `${targetBg}${A.bold}${A.white}${targetBtnText}${A.reset}`;
    const sendStyled = `${A.bgActiveNav}${A.bold}${A.white}${sendBtnText}${A.reset}`;
    const clearStyled = `${A.bgSelected}${A.gray}${clearBtnText}${A.reset}`;

    const ctrlLine = `${bg}${" ".repeat(leftPad0)}${targetStyled}${bg}  ${sendStyled}${bg}  ${clearStyled}`;
    lines[curR] = fitToWidth(ctrlLine, mainWidth, bg);
    curR++;
  }

  // 4. Subtle Hint Row on Home/Empty
  if (showHeading && curR < availableHeight) {
    const hint = `${A.gray}[Tab] Sub-Tabs  [/] Commands  [Ctrl+B] Menu  [Enter] Send${A.reset}`;
    const hintW = stringWidth(hint);
    const hintPad = Math.max(0, Math.floor((mainWidth - hintW) / 2));
    lines[curR] = fitToWidth(`${bg}${" ".repeat(hintPad)}${hint}`, mainWidth, bg);
    curR++;
  }

  // 5. Anchor Floating Dropdowns cleanly (below if room, otherwise above!)
  if (showSlash && slashEntries.length > 0) {
    const roomBelow = availableHeight - (boxTopRow + 3);
    const anchorStart = roomBelow >= slashEntries.length
      ? boxTopRow + 3
      : Math.max(0, boxTopRow - slashEntries.length);
    overlayBoxOntoLines(lines, anchorStart, screenStartRow, leftPad0, slashEntries);
  } else if (showTargetDrop && targetEntries.length > 0) {
    const roomBelow = availableHeight - (controlsRowIdx + 1);
    const anchorStart = roomBelow >= targetEntries.length
      ? controlsRowIdx + 1
      : Math.max(0, boxTopRow - targetEntries.length);
    overlayBoxOntoLines(lines, anchorStart, screenStartRow, leftPad0, targetEntries);
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────
//  CONVERSATION / INBOX / CHANNELS RENDERER
// ─────────────────────────────────────────────────────────────────
function renderThreadAndComposer(mainWidth, bodyHeight, screenStartRow, isChannel) {
  const bg = getCanvasBg();
  const targetName = isChannel ? selectedChannel : selectedAgent;
  const msgs = isChannel
    ? (readChannel(targetName) || [])
    : (readInbox(targetName) || []);

  // Empty conversation -> Centered Composer with target heading!
  if (!msgs || msgs.length === 0) {
    const prefix = isChannel ? `#${targetName}` : `@${targetName}`;
    return renderComposerPanel(mainWidth, bodyHeight, screenStartRow, {
      centeredVertically: true,
      showHeading: true,
      headingText: `✉ Intercom`,
      subHeadingText: `${prefix} · No messages yet`
    });
  }

  // Active conversation with messages -> clean header + high-contrast speech bubbles + centered-width composer
  const composerH = Math.min(bodyHeight - 4, 4); // 3-row box + 1-row controls
  const streamTotalH = Math.max(4, bodyHeight - composerH);
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  // Header row (row 0 of body)
  const targetTag = isChannel ? `${A.magenta}${A.bold}#${targetName}${A.reset}` : `${A.cyan}${A.bold}@${targetName}${A.reset}`;
  const online = !isChannel && (targetName === "antigravity" || targetName === "opencode" || targetName === "coordinator");
  const statusPill = isChannel
    ? `${A.gray}· Topic Channel (${msgs.length})${A.reset}`
    : `${online ? `${A.green}● Online` : `${A.gray}○ Offline`}${A.reset} ${A.gray}· Inbox (${msgs.length})${A.reset}`;
  const refreshBtn = "[ ↻ Refresh ]";
  const refreshW = stringWidth(refreshBtn);
  const refreshCol1 = Math.max(2, mainWidth - refreshW - 1);
  registerHitbox(screenStartRow, refreshCol1, refreshCol1 + refreshW - 1, "btn_refresh", {});

  const leftHdr = `  ${targetTag}  ${statusPill}`;
  const hdrGap = Math.max(1, refreshCol1 - stringWidth(leftHdr) - 1);
  lines[0] = fitToWidth(`${bg}${leftHdr}${bg}${" ".repeat(hdrGap)}${A.bgSelected}${A.cyan}${refreshBtn}${A.reset}`, mainWidth, bg);

  // Build speech bubbles centered cleanly
  const streamW = Math.min(82, Math.max(40, Math.floor(mainWidth * 0.78)));
  const streamPad0 = Math.max(1, Math.floor((mainWidth - streamW) / 2));
  const bubbleRows = [];
  const recent = msgs.slice(-25);

  for (const m of recent) {
    const from = m.from || m.sender || "unknown";
    const isSelf = from === "operator" || from === "exdelegate";
    const tsRaw = m.timestamp || "";
    const ts = settings.showTimestamps
      ? (tsRaw.includes("T") ? tsRaw.split("T")[1].slice(0, 8) : tsRaw)
      : "";
    const isRead = Boolean(m.read || (m.metadata && m.metadata.read));
    const receiptBadge = settings.readReceipts && !isChannel
      ? (isRead ? ` ${A.dim}[READ]${A.reset}` : ` ${A.yellow}[UNREAD]${A.reset}`)
      : "";
    const body = String(m.message || (m.payload && m.payload.message) || m.body || "").trim();

    const senderColor = isChannel ? A.magenta : (isSelf ? A.green : A.cyan);
    const bubbleBg = isSelf ? A.bgBubbleSelf : A.bgBubble;
    const bubbleW = Math.min(streamW, Math.max(30, streamW - 2));
    const tsPart = ts ? `  ${A.gray}${ts}${A.reset}` : "";
    const headerLabel = `${senderColor}${A.bold}@${from}${A.reset}${tsPart}${receiptBadge}`;
    const dashLen = Math.max(2, bubbleW - stringWidth(headerLabel) - 5);

    bubbleRows.push(`${senderColor}${B.tl}${B.h}${A.reset} ${headerLabel} ${senderColor}${B.h.repeat(dashLen)}${B.tr}${A.reset}`);

    const wrapped = wrapText(body, bubbleW - 4);
    for (const wl of wrapped) {
      const innerText = fitToWidth(` ${A.white}${wl}${A.reset}`, bubbleW - 2, bubbleBg);
      bubbleRows.push(`${senderColor}${B.v}${A.reset}${innerText}${senderColor}${B.v}${A.reset}`);
    }
    bubbleRows.push(`${senderColor}${B.bl}${B.h.repeat(bubbleW - 2)}${B.br}${A.reset}`);
    bubbleRows.push("");
  }

  // Slice visible window with scrollOffset
  const visibleH = Math.max(1, streamTotalH - 1);
  const maxScroll = Math.max(0, bubbleRows.length - visibleH);
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const startIdx = Math.max(0, bubbleRows.length - visibleH - scrollOffset);
  const slice = bubbleRows.slice(startIdx, startIdx + visibleH);

  for (let i = 0; i < slice.length; i++) {
    const r = 1 + i;
    if (r >= streamTotalH) break;
    lines[r] = fitToWidth(`${bg}${" ".repeat(streamPad0)}${slice[i]}`, mainWidth, bg);
  }

  // Render centered-width composer at bottom of thread
  const composerLines = renderComposerPanel(mainWidth, bodyHeight, screenStartRow, {
    centeredVertically: false,
    showHeading: false
  });
  // Copy bottom composer rows (and any anchored overlay dropdowns above the composer!)
  const composerTopRow = bodyHeight - composerH;
  const showOverlay = isSlashMenuVisible() || targetDropdownOpen;
  const copyStart = showOverlay ? 1 : composerTopRow;
  for (let r = copyStart; r < bodyHeight; r++) {
    // Only overwrite stream rows where an overlay dropdown actually drew non-empty content
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
//  PEERS, INFO, SETTINGS & HELP VIEWS
// ─────────────────────────────────────────────────────────────────
function renderPeersView(mainWidth, bodyHeight, screenStartRow) {
  const bg = getCanvasBg();
  const cardW = Math.min(76, Math.max(42, Math.floor(mainWidth * 0.78)));
  const padL0 = Math.max(1, Math.floor((mainWidth - cardW) / 2));
  const inner = cardW - 2;
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  const refreshBtn = "[ ↻ Refresh ]";
  const refW = stringWidth(refreshBtn);
  const refCol1 = padL0 + cardW - refW;
  registerHitbox(screenStartRow + 1, refCol1, refCol1 + refW - 1, "btn_refresh", {});

  let r = 1;
  if (r < bodyHeight) {
    const hdr = `${A.bold}${A.cyan}● Active Agent Peers${A.reset}`;
    const gap = Math.max(1, cardW - stringWidth(hdr) - refW);
    lines[r] = fitToWidth(`${bg}${" ".repeat(padL0)}${hdr}${bg}${" ".repeat(gap)}${A.bgSelected}${A.cyan}${refreshBtn}${A.reset}`, mainWidth, bg);
    r += 2;
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }

  for (let i = 0; i < agentList.length && r < bodyHeight - 2; i++) {
    const name = agentList[i];
    const meta = agentMetaMap.get(name) || { total: 0, unread: 0 };
    const online = name === "antigravity" || name === "opencode" || name === "coordinator";
    const dot = online ? `${A.green}●${A.reset}` : `${A.gray}○${A.reset}`;
    const unread = meta.unread > 0 ? ` ${A.yellow}[${meta.unread} unread]${A.reset}` : "";
    const total = meta.total > 0 ? ` ${A.gray}(${meta.total} msgs)${A.reset}` : ` ${A.dim}(idle)${A.reset}`;
    const isSel = name === selectedAgent;
    const rowBg = isSel ? A.bgSelected : A.bgInput;
    const openBadge = `${A.cyan}[ Open ]${A.reset}`;
    const leftPart = `  ${dot}  ${A.bold}${A.white}@${name}${A.reset}${unread}${total}`;
    const gap = Math.max(1, inner - stringWidth(leftPart) - stringWidth(openBadge) - 1);
    const content = fitToWidth(`${leftPart}${" ".repeat(gap)}${openBadge}`, inner, rowBg);

    registerHitbox(screenStartRow + r, padL0 + 1, padL0 + cardW, "select_agent", { name, index: i });
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.v}${A.reset}${content}${A.cyan}${B.v}${A.reset}`, mainWidth, bg);
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  return lines;
}

function renderInfoView(mainWidth, bodyHeight, screenStartRow) {
  const bg = getCanvasBg();
  const cardW = Math.min(78, Math.max(44, Math.floor(mainWidth * 0.80)));
  const padL0 = Math.max(1, Math.floor((mainWidth - cardW) / 2));
  const inner = cardW - 2;
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  const refreshBtn = "[ ↻ Refresh ]";
  const refW = stringWidth(refreshBtn);
  const refCol1 = padL0 + cardW - refW;
  registerHitbox(screenStartRow + 1, refCol1, refCol1 + refW - 1, "btn_refresh", {});

  let r = 1;
  if (r < bodyHeight) {
    const hdr = `${A.bold}${A.cyan}ℹ Intercom Mesh Health & System Info${A.reset}`;
    const gap = Math.max(1, cardW - stringWidth(hdr) - refW);
    lines[r] = fitToWidth(`${bg}${" ".repeat(padL0)}${hdr}${bg}${" ".repeat(gap)}${A.bgActiveNav}${A.bold}${A.white}${refreshBtn}${A.reset}`, mainWidth, bg);
    r += 2;
  }

  const svcs = meshInfoCache.services || {};
  const svcRow = (label, svc) => {
    const st = svc && svc.status;
    const pill = st === "ONLINE"
      ? `${A.green}[ONLINE] ${A.reset}`
      : (st === "OFFLINE" ? `${A.red}[OFFLINE]${A.reset}` : `${A.gray}[CACHED] ${A.reset}`);
    return fitToWidth(`  ${pill}  ${A.bold}${A.white}${label}${A.reset}`, inner, A.bgInput);
  };

  const rowsToDraw = [
    svcRow("Pi Broker Service   ", svcs.piBroker),
    svcRow("OpenCode API Engine ", svcs.opencodeApi),
    svcRow("Hermes AI Gateway   ", svcs.hermesGateway),
    svcRow("Local Mesh Daemon   ", svcs.intercomDaemon),
    fitToWidth("", inner, A.bgInput),
    fitToWidth(`  ${A.gray}Registered Peers :${A.reset} ${A.cyan}${meshStats.peers}${A.reset}    ${A.gray}Unread:${A.reset} ${A.yellow}${meshStats.unread}${A.reset}`, inner, A.bgInput),
    fitToWidth(`  ${A.gray}Topic Channels   :${A.reset} ${A.magenta}${meshStats.channels}${A.reset}    ${A.gray}DLQ   :${A.reset} ${meshStats.dlq > 0 ? A.red : A.green}${meshStats.dlq} failed${A.reset}`, inner, A.bgInput),
    fitToWidth(`  ${A.gray}Mesh Root        :${A.reset} ${A.softWhite}${MESH_DIR}${A.reset}`, inner, A.bgInput),
    fitToWidth(`  ${A.gray}Daemon Port      :${A.reset} ${A.softWhite}${PORT || 4150}${A.reset}`, inner, A.bgInput),
    fitToWidth("", inner, A.bgInput),
    fitToWidth(`  ${A.green}✔${A.reset} ${A.gray}Pure Messaging Mode · NTFS Safe-Rename · Directory Jail Verified${A.reset}`, inner, A.bgInput)
  ];

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }
  for (const content of rowsToDraw) {
    if (r >= bodyHeight - 1) break;
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.v}${A.reset}${content}${A.cyan}${B.v}${A.reset}`, mainWidth, bg);
  }
  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  return lines;
}

function renderSettingsView(mainWidth, bodyHeight, screenStartRow) {
  const bg = getCanvasBg();
  const cardW = Math.min(78, Math.max(44, Math.floor(mainWidth * 0.80)));
  const padL0 = Math.max(1, Math.floor((mainWidth - cardW) / 2));
  const inner = cardW - 2;
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  let r = 1;
  if (r < bodyHeight) {
    const hdr = `${A.bold}${A.cyan}⚙ Intercom UI & Telemetry Settings${A.reset}  ${A.gray}(Click or Enter to toggle)${A.reset}`;
    lines[r] = fitToWidth(`${bg}${" ".repeat(padL0)}${hdr}`, mainWidth, bg);
    r += 2;
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }

  for (let i = 0; i < SETTINGS_OPTIONS.length && r < bodyHeight - 2; i++) {
    const opt = SETTINGS_OPTIONS[i];
    const enabled = Boolean(settings[opt.key]);
    const isSel = i === selectedSettingIndex;
    const rowBg = isSel ? A.bgSelected : A.bgInput;
    const cursor = isSel ? `${A.cyan}›${A.reset}` : " ";
    const togglePill = enabled
      ? `${A.bgActiveNav}${A.bold}${A.green} ON  ${A.reset}`
      : `${A.bgSelected}${A.gray} OFF ${A.reset}`;

    const labelPart = ` ${cursor} ${A.bold}${A.white}${padEnd(opt.label, 17)}${A.reset} ${togglePill}  ${A.gray}${opt.desc}${A.reset}`;
    const content = fitToWidth(labelPart, inner, rowBg);

    registerHitbox(screenStartRow + r, padL0 + 1, padL0 + cardW, "toggle_setting", { key: opt.key, index: i });
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.v}${A.reset}${content}${A.cyan}${B.v}${A.reset}`, mainWidth, bg);
  }

  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  return lines;
}

function renderHelpView(mainWidth, bodyHeight) {
  const bg = getCanvasBg();
  const cardW = Math.min(78, Math.max(44, Math.floor(mainWidth * 0.80)));
  const padL0 = Math.max(1, Math.floor((mainWidth - cardW) / 2));
  const inner = cardW - 2;
  const lines = Array.from({ length: bodyHeight }, () => bg + " ".repeat(mainWidth) + A.reset);

  let r = 1;
  if (r < bodyHeight) {
    lines[r] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.bold}${A.cyan}? Intercom Shortcuts & Slash Commands${A.reset}`, mainWidth, bg);
    r += 2;
  }
  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`, mainWidth, bg);
  }

  for (const sc of SLASH_COMMANDS) {
    if (r >= bodyHeight - 4) break;
    const row = fitToWidth(`  ${A.bold}${A.cyan}${padEnd(sc.syntax, 25)}${A.reset} ${A.softWhite}${sc.desc}${A.reset}`, inner, A.bgInput);
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.v}${A.reset}${row}${A.cyan}${B.v}${A.reset}`, mainWidth, bg);
  }

  if (r < bodyHeight - 2) {
    const keysLine = fitToWidth(`  ${A.gray}Keys: [Tab] Sub-Tabs  [Ctrl+B] Menu  [Ctrl+A/E/K/U/W] Readline  [F5] Refresh  [q] Quit${A.reset}`, inner, A.bgInput);
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.v}${A.reset}${keysLine}${A.cyan}${B.v}${A.reset}`, mainWidth, bg);
  }
  if (r < bodyHeight) {
    lines[r++] = fitToWidth(`${bg}${" ".repeat(padL0)}${A.cyan}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`, mainWidth, bg);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────
//  RENDER BOTTOM BAR (Status + Lower-Corner Telemetry Stats)
// ─────────────────────────────────────────────────────────────────
function renderBottomBar(cols, bottomRow) {
  const statsText = settings.showCornerStats ? formatCornerStats() : "";
  const statsW = stringWidth(statsText);
  const quitBtn = "[ Quit ]";
  const quitW = stringWidth(quitBtn);

  // Left side: status notice + [ Quit ] pill
  const quitCol1 = 2;
  registerHitbox(bottomRow, quitCol1, quitCol1 + quitW - 1, "btn_quit", {});
  const leftPart = ` ${A.bgSelected}${A.gray}${quitBtn}${A.reset}${A.bgFooter}  ${A.gray}${lastStatusNotice}${A.reset}`;

  if (!statsText) {
    return fitToWidth(`${A.bgFooter}${leftPart}`, cols, A.bgFooter);
  }

  const maxLeftW = Math.max(10, cols - statsW - 3);
  const clippedLeft = clipAnsi(leftPart, maxLeftW);
  const gap = Math.max(1, cols - stringWidth(clippedLeft) - statsW - 1);
  return fitToWidth(`${A.bgFooter}${clippedLeft}${A.bgFooter}${" ".repeat(gap)}${A.dim}${A.cyan}${statsText}${A.reset} `, cols, A.bgFooter);
}

// ─────────────────────────────────────────────────────────────────
//  FULL FRAME RENDERER (Headless-Testable & Blessed Paint Target)
// ─────────────────────────────────────────────────────────────────
function renderFrame(colsArg, rowsArg) {
  const cols = Math.max(60, colsArg || screen.cols || screen.width || 80);
  const rows = Math.max(18, rowsArg || screen.rows || screen.height || 24);
  hitboxes = [];

  const topLine = renderTopBar(cols);
  const bodyHeight = Math.max(8, rows - 2);
  const startRow = 2;
  const sidebarW = rightSidebarOpen ? Math.min(28, Math.max(22, Math.floor(cols * 0.26))) : 0;
  const mainWidth = Math.max(36, cols - sidebarW);

  let mainLines;
  if (activeNav === 0) {
    mainLines = renderComposerPanel(mainWidth, bodyHeight, startRow, {
      centeredVertically: true,
      showHeading: true,
      headingText: "✉ Intercom"
    });
  } else if (activeNav === 1) {
    mainLines = renderThreadAndComposer(mainWidth, bodyHeight, startRow, false);
  } else if (activeNav === 2) {
    mainLines = renderThreadAndComposer(mainWidth, bodyHeight, startRow, true);
  } else if (activeNav === 3) {
    mainLines = renderPeersView(mainWidth, bodyHeight, startRow);
  } else if (activeNav === 4) {
    mainLines = renderInfoView(mainWidth, bodyHeight, startRow);
  } else if (activeNav === 5) {
    mainLines = renderSettingsView(mainWidth, bodyHeight, startRow);
  } else {
    mainLines = renderHelpView(mainWidth, bodyHeight);
  }

  const sidebarLines = rightSidebarOpen ? renderSidebar(sidebarW, bodyHeight, startRow, cols) : [];

  const frame = [topLine];
  for (let r = 0; r < bodyHeight; r++) {
    const leftPart = mainLines[r] || fitToWidth("", mainWidth, getCanvasBg());
    if (rightSidebarOpen) {
      const rightPart = sidebarLines[r] || fitToWidth("", sidebarW, A.bgSidebar);
      frame.push(leftPart + rightPart);
    } else {
      frame.push(leftPart);
    }
  }
  frame.push(renderBottomBar(cols, rows));

  return frame.slice(0, rows);
}

// ─────────────────────────────────────────────────────────────────
//  FULL REFRESH & LIST LOADING (Cached Info Probing)
// ─────────────────────────────────────────────────────────────────
async function loadLists() {
  let totalUnread = 0;
  try {
    const rawPeers = await listActiveMailboxes({ excludeEphemeral: true });
    const diskMap = new Map(rawPeers.map((p) => [p.name.toLowerCase(), p]));
    const allPeers = [];
    for (const kp of KNOWN_DEFAULT_PEERS) {
      const m = diskMap.get(kp) || { name: kp, total: 0, unread: 0 };
      allPeers.push(m);
      diskMap.delete(kp);
    }
    for (const extra of diskMap.values()) {
      allPeers.push(extra);
    }
    agentMetaMap = new Map();
    for (const p of allPeers) {
      agentMetaMap.set(p.name, { total: p.total || 0, unread: p.unread || 0 });
      totalUnread += p.unread || 0;
    }
    agentList = allPeers.map((p) => p.name);
    const foundIdx = agentList.indexOf(selectedAgent);
    agentIdx = foundIdx >= 0 ? foundIdx : 0;
    if (agentList.length > 0 && !agentList.includes(selectedAgent)) {
      selectedAgent = agentList[agentIdx];
    }
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
    const allCh = [];
    for (const d of KNOWN_DEFAULT_CHANNELS) {
      const c = chMap.get(d) || { name: d, total: 0 };
      allCh.push({ name: d, total: c.total || 0 });
      chMap.delete(d);
    }
    for (const [k, c] of chMap.entries()) {
      allCh.push({ name: k, total: c.total || 0 });
    }
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

async function refreshMeshInfo() {
  await loadLists();
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

async function refresh() {
  const frame = renderFrame(screen.cols || screen.width || 80, screen.rows || screen.height || 24);
  try {
    mainCanvasBox.setContent(frame.join("\n"));
    screen.render();
  } catch {}
  return frame;
}

// ─────────────────────────────────────────────────────────────────
//  SLASH COMMAND EXECUTION & MESSAGE DISPATCH
// ─────────────────────────────────────────────────────────────────
async function dispatchMessage(isChannel, target, body) {
  const cleanTarget = String(target || "").replace(/^[@#]/, "").trim();
  const cleanBody = String(body || "").trim();
  if (!cleanTarget || !cleanBody) return { ok: false, reason: "empty" };

  if (isChannel) {
    sendChannelMessage(cleanTarget, "operator", cleanBody);
    selectedType = "channel";
    selectedChannel = cleanTarget;
    ensureTargetSubTab("channel", cleanTarget, true);
    logActivity(`Broadcast → #${cleanTarget}: ${cleanBody.slice(0, 50)}`);
    lastStatusNotice = `✔ Broadcasted to #${cleanTarget}`;
    return { ok: true, target: `#${cleanTarget}`, message: cleanBody };
  }

  try {
    await writeMessage(cleanTarget, {
      sender: "operator",
      recipient: cleanTarget,
      priority: "NORMAL",
      payload: { message: cleanBody }
    });
    selectedType = "peer";
    selectedAgent = cleanTarget;
    ensureTargetSubTab("peer", cleanTarget, true);
    logActivity(`Sent → @${cleanTarget}: ${cleanBody.slice(0, 50)}`);
    lastStatusNotice = `✔ Sent to @${cleanTarget}`;
    return { ok: true, target: `@${cleanTarget}`, message: cleanBody };
  } catch (err) {
    lastStatusNotice = `Send error: ${err.message}`;
    return { ok: false, error: err.message };
  }
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
      slashMenuDismissed = false;
      lastStatusNotice = "Usage: /msg <peer> <text>";
      await refresh();
      return { handled: true, action: "slash_prefill", cmd: "/msg" };
    }
    const res = await dispatchMessage(false, peer, text);
    composerBuffer = "";
    composerCursor = 0;
    await loadLists();
    await refresh();
    return { handled: true, action: "slash_msg", ...res };
  }

  if (cmd === "/channel" || cmd === "/ch") {
    const parts = rest.split(/\s+/);
    const chName = (parts[0] || "").replace(/^#/, "");
    const text = rest.slice(parts[0]?.length || 0).trim();
    if (!chName || !text) {
      composerBuffer = "/channel ";
      composerCursor = composerBuffer.length;
      composerFocused = true;
      slashMenuDismissed = false;
      lastStatusNotice = "Usage: /channel <name> <text>";
      await refresh();
      return { handled: true, action: "slash_prefill", cmd: "/channel" };
    }
    const res = await dispatchMessage(true, chName, text);
    composerBuffer = "";
    composerCursor = 0;
    await loadLists();
    await refresh();
    return { handled: true, action: "slash_channel", ...res };
  }

  // Clear prompt for non-arg slash commands
  composerBuffer = "";
  composerCursor = 0;
  slashMenuDismissed = false;

  if (cmd === "/peers") {
    activeNav = 3;
    lastStatusNotice = "Opened Peer Mailboxes";
  } else if (cmd === "/info" || cmd === "/health") {
    activeNav = 4;
    lastStatusNotice = "Opened Mesh Health & Info";
  } else if (cmd === "/settings") {
    activeNav = 5;
    lastStatusNotice = "Opened Intercom Settings";
  } else if (cmd === "/refresh") {
    await refreshMeshInfo();
  } else if (cmd === "/clear") {
    if (activeNav === 1 && selectedAgent) {
      await clearInbox(selectedAgent);
      await loadLists();
      lastStatusNotice = `Cleared inbox for @${selectedAgent}`;
    } else {
      lastStatusNotice = "Cleared prompt";
    }
  } else if (cmd === "/menu") {
    rightSidebarOpen = !rightSidebarOpen;
    lastStatusNotice = rightSidebarOpen ? "Menu opened" : "Menu closed";
  } else if (cmd === "/new") {
    openNewSubTab();
  } else if (cmd === "/help") {
    activeNav = 6;
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
      activeNav = p.index ?? 0;
      targetDropdownOpen = false;
      if (activeNav === 0) activeSubTabIndex = 0;
      await refresh();
      break;

    case "select_agent":
      selectedAgent = p.name;
      agentIdx = p.index ?? Math.max(0, agentList.indexOf(p.name));
      selectedType = "peer";
      activeNav = 1;
      targetDropdownOpen = false;
      ensureTargetSubTab("peer", p.name, true);
      await refresh();
      break;

    case "select_channel":
      selectedChannel = p.name;
      channelIdx = p.index ?? Math.max(0, channelList.indexOf(p.name));
      selectedType = "channel";
      activeNav = 2;
      targetDropdownOpen = false;
      ensureTargetSubTab("channel", p.name, true);
      await refresh();
      break;

    case "switch_subtab":
      switchSubTab(p.index ?? p.id);
      targetDropdownOpen = false;
      await refresh();
      break;

    case "close_subtab":
      closeSubTab(p.index ?? p.id);
      targetDropdownOpen = false;
      await refresh();
      break;

    case "new_subtab":
      openNewSubTab();
      targetDropdownOpen = false;
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
        if (activeNav === 1 || activeNav === 2) {
          ensureTargetSubTab("peer", p.name, true);
        }
      } else if (p.type === "channel") {
        selectedType = "channel";
        selectedChannel = p.name;
        channelIdx = p.index ?? Math.max(0, channelList.indexOf(p.name));
        if (activeNav === 1 || activeNav === 2) {
          ensureTargetSubTab("channel", p.name, true);
        }
      }
      targetDropdownOpen = false;
      composerFocused = true;
      await refresh();
      break;

    case "select_slash_command": {
      const cmd = p.cmd || "";
      if (p.hasArgs) {
        composerBuffer = `${cmd} `;
        composerCursor = composerBuffer.length;
        composerFocused = true;
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
        lastStatusNotice = "Prompt cleared";
      } else if (activeNav === 1 && selectedAgent) {
        await clearInbox(selectedAgent);
        await loadLists();
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
//  KEYBOARD HANDLER (Unified Readline, Sub-Tabs, Dropdowns, Ctrl+B)
// ─────────────────────────────────────────────────────────────────
async function handleKey(str, key = {}) {
  if (!key) return { handled: false };

  // Global quit
  if ((key.ctrl && key.name === "c") || (!composerBuffer && !targetDropdownOpen && str === "q" && !composerFocused)) {
    cleanExit();
    return { handled: true, action: "quit" };
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
    const hasSpaceAfterCmd = composerBuffer.trimStart().includes(" ");

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
    if (key.name === "return" && !hasSpaceAfterCmd) {
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

  // Settings View Up/Down/Enter/Space navigation when prompt empty
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

  // Tab key: autocomplete @/# if starting with @/#, else switch top-left sub-tabs!
  if (key.name === "tab") {
    if (composerBuffer.startsWith("@")) {
      const idx = (agentList.indexOf(selectedAgent) + 1) % Math.max(1, agentList.length);
      selectedAgent = agentList[idx] || "antigravity";
      composerBuffer = `@${selectedAgent} `;
      composerCursor = composerBuffer.length;
      await refresh();
      return { handled: true, action: "autocomplete_peer" };
    }
    if (composerBuffer.startsWith("#")) {
      const idx = (channelList.indexOf(selectedChannel) + 1) % Math.max(1, channelList.length);
      selectedChannel = channelList[idx] || "general";
      composerBuffer = `#${selectedChannel} `;
      composerCursor = composerBuffer.length;
      await refresh();
      return { handled: true, action: "autocomplete_channel" };
    }
    if (key.shift) prevSubTab();
    else nextSubTab();
    await refresh();
    return { handled: true, action: "switch_subtab" };
  }

  // Enter: send or execute slash command
  if (key.name === "return") {
    return doSend();
  }

  // Escape: clear buffer or close sidebar
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
    return { handled: false };
  }

  // Up/Down when on Inbox/Channels/Peers and prompt empty -> scroll or navigate
  if ((key.name === "up" || key.name === "down") && composerBuffer.length === 0) {
    const delta = key.name === "up" ? -1 : 1;
    if (activeNav === 3 && agentList.length > 0) {
      agentIdx = Math.max(0, Math.min(agentList.length - 1, agentIdx + delta));
      selectedAgent = agentList[agentIdx];
      await refresh();
      return { handled: true, action: "peer_move" };
    }
    if (activeNav === 1 || activeNav === 2) {
      scrollOffset = Math.max(0, scrollOffset - delta * 2);
      await refresh();
      return { handled: true, action: "scroll" };
    }
  }

  // Readline composer editing
  const bufState = { value: composerBuffer, cursor: composerCursor };
  if (applyReadlineKey(bufState, str, key)) {
    const changed = bufState.value !== composerBuffer;
    composerBuffer = bufState.value;
    composerCursor = bufState.cursor;
    composerFocused = true;
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
//  MOUSE EVENT DISPATCH (Blessed + Direct SGR 1006 Stream Decoder)
// ─────────────────────────────────────────────────────────────────
screen.on("mouse", (data) => {
  if (!data || (data.action !== "mousedown" && data.action !== "click")) return;
  handleHit(data.y + 1, data.x + 1);
});

const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
if (screen.program && !isHeadlessTest) {
  screen.program.on("data", (data) => {
    const str = typeof data === "string" ? data : data.toString("utf8");
    const matches = str.matchAll(sgrRegex);
    for (const m of matches) {
      const rawBtn = parseInt(m[1], 10);
      const col = parseInt(m[2], 10);
      const row = parseInt(m[3], 10);
      const isRelease = m[4] === "m";
      if (!isRelease && rawBtn === 0) {
        handleHit(row, col);
      } else if (!isRelease && rawBtn === 64) {
        scrollOffset = scrollOffset + 3;
        refresh();
      } else if (!isRelease && rawBtn === 65) {
        scrollOffset = Math.max(0, scrollOffset - 3);
        refresh();
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
//  LIVE WATCHER & BOOT GUARD
// ─────────────────────────────────────────────────────────────────
let watcher = null;
let pollInterval = null;

if (!isHeadlessTest) {
  try {
    watcher = chokidar.watch(MESH_DIR, {
      persistent:    true,
      ignoreInitial: true,
      depth:         3,
      usePolling:    process.platform === "win32",
      interval:      800
    });
    watcher.on("all", async () => {
      await loadLists();
      await refresh();
    });
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
  registerHitbox,
  hitTest,
  getHitboxes: () => hitboxes,
  clearHitboxes: () => { hitboxes = []; },
  handleHit,
  executeHitAction,
  handleKey,
  doSend,
  executeSlashCommand,
  renderTopBar,
  renderSidebar,
  renderFrame,
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
    activeView: (NAV_TABS[activeNav] || "Home").toLowerCase(),
    rightSidebarOpen,
    sidebarOpen: rightSidebarOpen,
    selectedType,
    selectedAgent,
    selectedChannel,
    agentList,
    channelList,
    agentIdx,
    channelIdx,
    subTabs: subTabs.map((t) => ({ ...t })),
    activeSubTabIndex,
    composerBuffer,
    composerCursor,
    composerFocused,
    targetDropdownOpen,
    targetDropdownIndex,
    slashMenuOpen: isSlashMenuVisible(),
    slashSelectedIndex,
    settings: { ...settings },
    selectedSettingIndex,
    scrollOffset,
    lastStatusNotice,
    meshStats: { ...meshStats }
  }),
  setState: (patch = {}) => {
    if (patch.activeNav !== undefined) activeNav = patch.activeNav;
    if (patch.rightSidebarOpen !== undefined) rightSidebarOpen = Boolean(patch.rightSidebarOpen);
    if (patch.sidebarOpen !== undefined) rightSidebarOpen = Boolean(patch.sidebarOpen);
    if (patch.selectedType !== undefined) selectedType = patch.selectedType;
    if (patch.selectedAgent !== undefined) selectedAgent = patch.selectedAgent;
    if (patch.selectedChannel !== undefined) selectedChannel = patch.selectedChannel;
    if (patch.agentList !== undefined) agentList = [...patch.agentList];
    if (patch.channelList !== undefined) channelList = [...patch.channelList];
    if (patch.agentIdx !== undefined) agentIdx = patch.agentIdx;
    if (patch.channelIdx !== undefined) channelIdx = patch.channelIdx;
    if (patch.subTabs !== undefined) subTabs = patch.subTabs.map((t) => ({ ...t }));
    if (patch.activeSubTabIndex !== undefined) activeSubTabIndex = patch.activeSubTabIndex;
    if (patch.composerBuffer !== undefined) {
      composerBuffer = String(patch.composerBuffer);
      composerCursor = composerBuffer.length;
      slashMenuDismissed = false;
    }
    if (patch.composerCursor !== undefined) composerCursor = patch.composerCursor;
    if (patch.composerFocused !== undefined) composerFocused = Boolean(patch.composerFocused);
    if (patch.targetDropdownOpen !== undefined) targetDropdownOpen = Boolean(patch.targetDropdownOpen);
    if (patch.targetDropdownIndex !== undefined) targetDropdownIndex = patch.targetDropdownIndex;
    if (patch.slashMenuDismissed !== undefined) slashMenuDismissed = Boolean(patch.slashMenuDismissed);
    if (patch.slashSelectedIndex !== undefined) slashSelectedIndex = patch.slashSelectedIndex;
    if (patch.settings !== undefined) settings = { ...settings, ...patch.settings };
    if (patch.selectedSettingIndex !== undefined) selectedSettingIndex = patch.selectedSettingIndex;
    if (patch.scrollOffset !== undefined) scrollOffset = patch.scrollOffset;
    if (patch.meshStats !== undefined) meshStats = { ...meshStats, ...patch.meshStats };
  },
  sgrRegex,
  parseSgrSequence: (str) => {
    const matches = str.matchAll(sgrRegex);
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
  },
  destroyScreen: () => {
    if (pollInterval) clearInterval(pollInterval);
    if (watcher) { try { watcher.close(); } catch {} }
    try { screen.destroy(); } catch {}
    try { if (process.stdin.pause) process.stdin.pause(); } catch {}
    try { if (process.stdin.unref) process.stdin.unref(); } catch {}
  }
};
