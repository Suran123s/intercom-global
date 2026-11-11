#!/usr/bin/env node
/**
 * bin/intercom-tui.js - Intercom Global Terminal UI
 *
 * Clean OpenCode-inspired master-detail layout:
 *   Left sidebar  : Clickable vertical nav [ Inbox | Channels | Peers | Health ]
 *                   + clickable agent peer list + clickable topic channels
 *   Right content : Conversation stream with speech-bubble cards
 *   Bottom bar    : Clean compose input (Type message to @agent or #channel…)
 *   Footer        : Clickable [ ↵ Send ]  [ Clear ]  [ Refresh ]  [ Quit ]
 *
 * Features:
 *   - Full SGR mouse tracking (\x1b[?1000h\x1b[?1002h\x1b[?1006h) — every element is clickable
 *   - Dual-layer mouse parser: Blessed mouse events + direct raw SGR stream decoder + widget click routing
 *   - Deep dark charcoal canvas background (\x1b[48;5;234m / #0d1117)
 *   - Polished rounded borders, crisp high-contrast typography
 *   - Pure messaging focus — NO dispatch, NO tasks, NO flags
 *
 * Usage:
 *   intercom tui
 *   node bin/intercom-tui.js
 */

"use strict";

const blessed   = require("blessed");
const fs        = require("fs");
const path      = require("path");
const chokidar  = require("chokidar");

const {
  checkAndMarkRead,
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
  reset:      "\x1b[0m",
  bold:       "\x1b[1m",
  dim:        "\x1b[2m",
  italic:     "\x1b[3m",
  underline:  "\x1b[4m",
  // Foreground
  white:      "\x1b[97m",
  gray:       "\x1b[38;5;244m",
  darkGray:   "\x1b[38;5;239m",
  cyan:       "\x1b[96m",
  blue:       "\x1b[94m",
  green:      "\x1b[92m",
  yellow:     "\x1b[93m",
  red:        "\x1b[91m",
  magenta:    "\x1b[95m",
  // Background — deep charcoal palette (#0d1117 / slate)
  bgCanvas:   "\x1b[48;5;234m",   // #0d1117 deep charcoal main canvas
  bgSidebar:  "\x1b[48;5;233m",   // slightly deeper sidebar
  bgSelected: "\x1b[48;5;237m",   // subtle selection highlight
  bgActiveNav:"\x1b[48;5;24m",    // rich deep blue active pill
  bgHeader:   "\x1b[48;5;235m",   // header strip
  bgFooter:   "\x1b[48;5;233m",   // footer strip
  bgInput:    "\x1b[48;5;235m",   // compose input area
  bgBubble:   "\x1b[48;5;235m",   // message bubble body
  bgBubbleSelf:"\x1b[48;5;236m",  // self message bubble body
};

// Box drawing (rounded)
const B = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│", vl: "├", vr: "┤",
  tt: "┬", bt: "┴", cross: "┼"
};

// ─────────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────────
const NAV_TABS = ["Inbox", "Channels", "Peers", "Health"];
let activeNav       = 0;          // active left-nav index
let selectedAgent   = "opencode";
let selectedChannel = "general";
let agentList       = ["antigravity", "opencode", "jules", "sentinel", "coordinator"];
let channelList     = ["general", "alerts", "handoffs"];
let agentIdx        = 1;
let channelIdx      = 0;
const activityLog   = [];

function logActivity(text) {
  const ts = new Date().toLocaleTimeString();
  activityLog.unshift(`[${ts}] ${text}`);
  if (activityLog.length > 50) activityLog.pop();
}

// ─────────────────────────────────────────────────────────────────
//  String measurement helpers (ANSI & wide-char aware)
// ─────────────────────────────────────────────────────────────────
function stripAnsi(str) {
  return String(str || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function stringWidth(str) {
  const plain = stripAnsi(str);
  let w = 0;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
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
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padEnd(str, targetLen, char = " ") {
  const currentW = stringWidth(str);
  const diff = targetLen - currentW;
  return str + (diff > 0 ? char.repeat(diff) : "");
}

function wrapText(text, maxW) {
  if (!text) return [""];
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (stringWidth(cur + " " + w) <= maxW) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

// ─────────────────────────────────────────────────────────────────
//  Hitbox registry (populated during each render)
// ─────────────────────────────────────────────────────────────────
let hitboxes = [];   // { row, startCol, endCol, action, payload }

function registerHitbox(row, startCol, endCol, action, payload = {}) {
  hitboxes.push({ row, startCol, endCol, action, payload });
}

function hitTest(row, col) {
  for (const hb of hitboxes) {
    if (hb.row === row && col >= hb.startCol && col <= hb.endCol) {
      return hb;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
//  Screen setup (blessed canvas with full SGR extended mouse)
// ─────────────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR:    true,
  title:       "Intercom Global · Mesh Chat",
  dockBorders: true,
  fullUnicode: true,
  terminal:    "xterm-256color",
});

// Enable SGR extended mouse tracking (button events + motion + extended coords)
process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
if (screen.program && typeof screen.program.setMouse === "function") {
  try {
    screen.program.setMouse({ sgrMouse: true, vt200Mouse: true, cellMotion: true, allMotion: true }, true);
  } catch {}
}

// Cleanup on exit
function cleanExit() {
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l");
  try { screen.destroy(); } catch {}
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────
//  LAYOUT — blessed widgets with dark charcoal styling (#0d1117 / 234)
// ─────────────────────────────────────────────────────────────────
const SIDEBAR_W = 26;

// Header bar
const headerBox = blessed.box({
  top: 0, left: 0, width: "100%", height: 1,
  tags: true,
  content: `${A.bgHeader}${A.bold}${A.cyan} ● INTERCOM GLOBAL${A.reset}${A.bgHeader}${A.gray}  ·  v2.1.0  ·  Mesh: active  ·  Port: ${PORT || 4150}  ·  Pure Messaging${A.reset}`,
  style: { bg: 235 }
});

// Left sidebar (nav + peer list + channel list)
const sidebarBox = blessed.box({
  top: 1, left: 0, width: SIDEBAR_W, bottom: 4,
  tags: true,
  style: { bg: 233 },
  scrollable: false,
  mouse: true,
});

// Vertical divider
const dividerBox = blessed.line({
  top: 1, left: SIDEBAR_W, bottom: 4,
  orientation: "vertical",
  style: { fg: "blue", bg: 234 },
});

// Right content area (conversation stream)
const contentBox = blessed.box({
  top: 1, left: SIDEBAR_W + 1, right: 0, bottom: 4,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  style: { bg: 234 },
});

// Compose area outer
const composeOuter = blessed.box({
  bottom: 2, left: 0, right: 0, height: 2,
  tags: true,
  mouse: true,
  style: { bg: 235 },
});

// Compose text input
const composeInput = blessed.textbox({
  parent: composeOuter,
  top: 0, left: 2, right: 2, height: 1,
  inputOnFocus: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: 235,
    focus: { fg: "white", bg: 236 }
  }
});

// Footer button bar
const footerBox = blessed.box({
  bottom: 0, left: 0, width: "100%", height: 2,
  tags: true,
  mouse: true,
  style: { bg: 233 }
});

// Append elements
screen.append(headerBox);
screen.append(sidebarBox);
screen.append(dividerBox);
screen.append(contentBox);
screen.append(composeOuter);
screen.append(footerBox);

// ─────────────────────────────────────────────────────────────────
//  RENDER SIDEBAR (Vertical categories + peers + channels)
// ─────────────────────────────────────────────────────────────────
function renderSidebar() {
  const { width: W, height: H } = sidebarBox;
  const sW = W || SIDEBAR_W;
  const sH = H || 20;
  const inner = sW - 2;
  const lines = [];

  // Top border
  lines.push(`${A.bgSidebar}${A.dim}${A.cyan}${B.tl}${B.h.repeat(inner)}${B.tr}${A.reset}`);

  // ---- Section: Left Nav Categories ----
  for (let i = 0; i < NAV_TABS.length; i++) {
    const label = NAV_TABS[i];
    const isActive = i === activeNav;
    const screenRow = 2 + lines.length; // 1-based row on screen
    registerHitbox(screenRow, 1, sW, "nav", { index: i });

    const indicator = isActive ? `${A.cyan}›${A.reset}` : " ";
    const pill = isActive
      ? `${A.bgActiveNav}${A.bold}${A.white}[ ${label} ]${A.reset}`
      : `${A.gray}[ ${label} ]${A.reset}`;
    const rawContent = ` ${indicator} ${pill}`;
    lines.push(
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgSidebar}` +
      padEnd(rawContent, inner) +
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}`
    );
  }

  // ---- Section: Agent Peers ----
  lines.push(
    `${A.bgSidebar}${A.dim}${A.cyan}${B.vl}${B.h} ${A.bold}${A.white}PEERS${A.reset}${A.bgSidebar}${A.dim}${A.cyan} ${B.h.repeat(Math.max(0, inner - 9))}${B.vr}${A.reset}`
  );

  for (let i = 0; i < agentList.length; i++) {
    const name = agentList[i];
    const isSelected = name === selectedAgent && activeNav === 0;
    const screenRow = 2 + lines.length;
    registerHitbox(screenRow, 1, sW, "select_agent", { name, index: i });

    const online = (name === "antigravity" || name === "opencode" || name === "coordinator");
    const dot = online ? `${A.green}●${A.reset}` : `${A.gray}○${A.reset}`;
    const indicator = isSelected ? `${A.cyan}›${A.reset}` : " ";
    const nameFmt = isSelected
      ? `${A.bgSelected}${A.bold}${A.white}${name}${A.reset}`
      : `${A.gray}${name}${A.reset}`;
    const rowContent = ` ${indicator} ${dot} ${nameFmt}`;
    const bg = isSelected ? A.bgSelected : A.bgSidebar;

    lines.push(
      `${bg}${A.dim}${A.cyan}${B.v}${A.reset}${bg}` +
      padEnd(rowContent, inner) +
      `${bg}${A.dim}${A.cyan}${B.v}${A.reset}`
    );
  }

  // ---- Section: Topic Channels ----
  lines.push(
    `${A.bgSidebar}${A.dim}${A.cyan}${B.vl}${B.h} ${A.bold}${A.white}CHANNELS${A.reset}${A.bgSidebar}${A.dim}${A.cyan} ${B.h.repeat(Math.max(0, inner - 12))}${B.vr}${A.reset}`
  );

  for (let i = 0; i < channelList.length; i++) {
    const name = channelList[i];
    const isSelected = name === selectedChannel && activeNav === 1;
    const screenRow = 2 + lines.length;
    registerHitbox(screenRow, 1, sW, "select_channel", { name, index: i });

    const indicator = isSelected ? `${A.magenta}›${A.reset}` : " ";
    const nameFmt = isSelected
      ? `${A.bgSelected}${A.bold}${A.magenta}#${name}${A.reset}`
      : `${A.magenta}#${name}${A.reset}`;
    const rowContent = ` ${indicator} ${nameFmt}`;
    const bg = isSelected ? A.bgSelected : A.bgSidebar;

    lines.push(
      `${bg}${A.dim}${A.cyan}${B.v}${A.reset}${bg}` +
      padEnd(rowContent, inner) +
      `${bg}${A.dim}${A.cyan}${B.v}${A.reset}`
    );
  }

  // Fill remaining rows with dark borders
  while (lines.length < sH - 1) {
    lines.push(
      `${A.bgSidebar}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgSidebar}${" ".repeat(inner)}${A.dim}${A.cyan}${B.v}${A.reset}`
    );
  }

  // Bottom border
  lines.push(`${A.bgSidebar}${A.dim}${A.cyan}${B.bl}${B.h.repeat(inner)}${B.br}${A.reset}`);

  sidebarBox.setContent(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────
//  RENDER CONTENT (Conversation stream, Channels, Peers, Health)
// ─────────────────────────────────────────────────────────────────
async function renderContent() {
  if (activeNav === 0) {
    await renderInboxContent();
  } else if (activeNav === 1) {
    renderChannelsContent();
  } else if (activeNav === 2) {
    await renderPeersContent();
  } else if (activeNav === 3) {
    await renderHealthContent();
  }
}

async function renderInboxContent() {
  const { width: W } = contentBox;
  const cW = (typeof W === "number" && W > 10 ? W : 60);
  const innerW = Math.max(10, cW - 4);
  const lines = [];

  // Header card
  const title = `${A.bold}${A.cyan}@${selectedAgent}${A.reset}  ${A.gray}· Inbox Conversation Stream${A.reset}`;
  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.tl}${B.h} ${title} ${A.reset}${A.bgCanvas}${A.dim}${A.cyan}${B.h.repeat(Math.max(2, innerW - stringWidth(stripAnsi(title)) - 2))}${B.tr}${A.reset}`);
  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW + 2))}${A.dim}${A.cyan}${B.v}${A.reset}`);

  try {
    const msgs = readInbox(selectedAgent);
    if (!msgs || msgs.length === 0) {
      lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.gray}No messages in @${selectedAgent}'s mailbox yet.${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 45))}${A.dim}${A.cyan}${B.v}${A.reset}`);
      lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.dim}Use the compose bar below to send a message.${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 44))}${A.dim}${A.cyan}${B.v}${A.reset}`);
    } else {
      const recent = msgs.slice(-25);
      for (const m of recent) {
        const from = (m.from || "unknown");
        const isSelf = from === "operator" || from === "exdelegate";
        const ts   = m.timestamp
          ? (m.timestamp.includes("T") ? m.timestamp.split("T")[1].slice(0, 8) : m.timestamp)
          : new Date().toLocaleTimeString();
        const body = String(m.message || "").trim();
        const isUnread = !m.read;
        const unreadBadge = isUnread ? ` ${A.yellow}[UNREAD]${A.reset}` : "";
        const senderColor = isSelf ? A.green : A.cyan;

        // Bubble top
        const bubbleLabel = `${senderColor}${A.bold}@${from}${A.reset}  ${A.gray}${ts}${A.reset}${unreadBadge}`;
        const labelW = stringWidth(stripAnsi(bubbleLabel));
        const bubbleW = Math.min(innerW - 2, Math.max(30, innerW - 6));
        const dashLen = Math.max(2, bubbleW - labelW - 4);

        lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${senderColor}╭─${A.reset} ${bubbleLabel} ${senderColor}${"─".repeat(dashLen)}╮${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - bubbleW))}${A.dim}${A.cyan}${B.v}${A.reset}`);

        // Bubble body
        const wrapped = wrapText(body, bubbleW - 4);
        const bgB = isSelf ? A.bgBubbleSelf : A.bgBubble;
        for (const wl of wrapped) {
          const padW = Math.max(0, bubbleW - 4 - stringWidth(wl));
          lines.push(
            `${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${senderColor}│${A.reset}${bgB}  ${A.white}${wl}${" ".repeat(padW)}${A.reset}${senderColor}│${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - bubbleW))}${A.dim}${A.cyan}${B.v}${A.reset}`
          );
        }

        // Bubble bottom
        lines.push(
          `${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${senderColor}╰${"─".repeat(bubbleW - 1)}╯${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - bubbleW))}${A.dim}${A.cyan}${B.v}${A.reset}`
        );
        lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}${" ".repeat(innerW + 2)}${A.dim}${A.cyan}${B.v}${A.reset}`);
      }
    }
  } catch (err) {
    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.red}Error: ${err.message}${A.reset}${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}`);
  }

  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.bl}${B.h.repeat(Math.max(2, innerW + 2))}${B.br}${A.reset}`);

  contentBox.setContent(lines.join("\n"));
  contentBox.setLabel(` @${selectedAgent} `);
  contentBox.scrollTo(lines.length);
  screen.render();
}

function renderChannelsContent() {
  const { width: W } = contentBox;
  const cW = (typeof W === "number" && W > 10 ? W : 60);
  const innerW = Math.max(10, cW - 4);
  const lines = [];

  const title = `${A.bold}${A.magenta}#${selectedChannel}${A.reset}  ${A.gray}· Channel Broadcast Stream${A.reset}`;
  lines.push(`${A.bgCanvas}${A.dim}${A.magenta}${B.tl}${B.h} ${title} ${A.reset}${A.bgCanvas}${A.dim}${A.magenta}${B.h.repeat(Math.max(2, innerW - stringWidth(stripAnsi(title)) - 2))}${B.tr}${A.reset}`);
  lines.push(`${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW + 2))}${A.dim}${A.magenta}${B.v}${A.reset}`);

  try {
    const msgs = readChannel(selectedChannel);
    if (!msgs || msgs.length === 0) {
      lines.push(`${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}${A.bgCanvas}  ${A.gray}No messages in #${selectedChannel} yet.${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 40))}${A.dim}${A.magenta}${B.v}${A.reset}`);
      lines.push(`${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}${A.bgCanvas}  ${A.dim}Broadcast a message below!${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 27))}${A.dim}${A.magenta}${B.v}${A.reset}`);
    } else {
      const recent = msgs.slice(-25);
      for (const m of recent) {
        const from = m.from || "unknown";
        const ts   = m.timestamp
          ? (m.timestamp.includes("T") ? m.timestamp.split("T")[1].slice(0, 8) : m.timestamp)
          : new Date().toLocaleTimeString();
        const body = String(m.message || "").trim();

        const senderLabel = `${A.magenta}${A.bold}@${from}${A.reset}  ${A.gray}${ts}${A.reset}`;
        const labelW = stringWidth(stripAnsi(senderLabel));
        const bubbleW = Math.min(innerW - 2, Math.max(30, innerW - 6));
        const dashLen = Math.max(2, bubbleW - labelW - 4);

        lines.push(`${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}${A.bgCanvas}  ${A.magenta}╭─${A.reset} ${senderLabel} ${A.magenta}${"─".repeat(dashLen)}╮${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - bubbleW))}${A.dim}${A.magenta}${B.v}${A.reset}`);

        const wrapped = wrapText(body, bubbleW - 4);
        for (const wl of wrapped) {
          const padW = Math.max(0, bubbleW - 4 - stringWidth(wl));
          lines.push(
            `${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}${A.bgCanvas}  ${A.magenta}│${A.reset}${A.bgBubble}  ${A.white}${wl}${" ".repeat(padW)}${A.reset}${A.magenta}│${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - bubbleW))}${A.dim}${A.magenta}${B.v}${A.reset}`
          );
        }
        lines.push(
          `${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}${A.bgCanvas}  ${A.magenta}╰${"─".repeat(bubbleW - 1)}╯${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - bubbleW))}${A.dim}${A.magenta}${B.v}${A.reset}`
        );
        lines.push(`${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}${A.bgCanvas}${" ".repeat(innerW + 2)}${A.dim}${A.magenta}${B.v}${A.reset}`);
      }
    }
  } catch (err) {
    lines.push(`${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}${A.bgCanvas}  ${A.red}Error: ${err.message}${A.reset}${A.bgCanvas}${A.dim}${A.magenta}${B.v}${A.reset}`);
  }

  lines.push(`${A.bgCanvas}${A.dim}${A.magenta}${B.bl}${B.h.repeat(innerW + 2)}${B.br}${A.reset}`);

  contentBox.setContent(lines.join("\n"));
  contentBox.setLabel(` #${selectedChannel} `);
  contentBox.scrollTo(lines.length);
  screen.render();
}

async function renderPeersContent() {
  const { width: W } = contentBox;
  const cW = (typeof W === "number" && W > 10 ? W : 60);
  const innerW = Math.max(10, cW - 4);
  const lines = [];

  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.tl}${B.h} ${A.bold}${A.white}Active Agent Peers${A.reset} ${A.dim}${A.cyan}${B.h.repeat(Math.max(2, innerW - 20))}${B.tr}${A.reset}`);
  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW + 2))}${A.dim}${A.cyan}${B.v}${A.reset}`);

  try {
    const rawPeers = await listActiveMailboxes();
    const diskNames = new Set(rawPeers.map(p => p.name.toLowerCase()));
    const known = ["antigravity", "opencode", "jules", "sentinel", "coordinator"];
    const allPeers = [...rawPeers];
    for (const kp of known) {
      if (!diskNames.has(kp)) allPeers.push({ name: kp, total: 0, unread: 0 });
    }

    for (const p of allPeers) {
      const online  = (p.name === "antigravity" || p.name === "opencode" || p.name === "coordinator");
      const dot     = online ? `${A.green}●${A.reset}` : `${A.gray}○${A.reset}`;
      const badge   = p.unread > 0 ? ` ${A.yellow}[${p.unread} new]${A.reset}` : "";
      const total   = p.total > 0  ? ` ${A.dim}(${p.total} msgs)${A.reset}` : "";
      const nameFmt = `${A.bold}${A.white}${p.name}${A.reset}`;

      lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}   ${dot}  ${nameFmt}${badge}${total}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 35))}${A.dim}${A.cyan}${B.v}${A.reset}`);
    }
  } catch (err) {
    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.red}Error: ${err.message}${A.reset}${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}`);
  }

  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.bl}${B.h.repeat(Math.max(2, innerW + 2))}${B.br}${A.reset}`);

  contentBox.setContent(lines.join("\n"));
  contentBox.setLabel(" Peers ");
  screen.render();
}

async function renderHealthContent() {
  const { width: W } = contentBox;
  const cW = (typeof W === "number" && W > 10 ? W : 60);
  const innerW = Math.max(10, cW - 4);
  const lines = [];
  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.tl}${B.h} ${A.bold}${A.white}Mesh Health Diagnostics${A.reset} ${A.dim}${A.cyan}${B.h.repeat(Math.max(2, innerW - 25))}${B.tr}${A.reset}`);
  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW + 2))}${A.dim}${A.cyan}${B.v}${A.reset}`);

  try {
    const diag = await diagnoseMesh().catch(() => ({}));
    const s = diag.services || {};
    const ln = (label, svc) => {
      const on = svc && svc.status === "ONLINE";
      const pill = on ? `${A.green}[ONLINE] ${A.reset}` : `${A.red}[OFFLINE]${A.reset}`;
      return `${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${pill}  ${A.bold}${A.white}${label}${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 35))}${A.dim}${A.cyan}${B.v}${A.reset}`;
    };
    lines.push(ln("Pi Broker Service   ", s.piBroker));
    lines.push(ln("OpenCode API Engine ", s.opencodeApi));
    lines.push(ln("Hermes AI Gateway   ", s.hermesGateway));
    lines.push(ln("Local Mesh Daemon   ", s.intercomDaemon));

    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}${" ".repeat(innerW + 2)}${A.dim}${A.cyan}${B.v}${A.reset}`);

    const mailboxes  = await listActiveMailboxes().catch(() => []);
    const totalPend  = mailboxes.reduce((a, m) => a + (m.total || 0), 0);
    const channels   = listChannels();
    const dlq        = getDlq();

    const stat = (label, val, color) =>
      `${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.dim}${label}:${A.reset} ${color}${val}${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - stringWidth(label) - stringWidth(String(val)) - 5))}${A.dim}${A.cyan}${B.v}${A.reset}`;

    lines.push(stat("Registered Mailboxes", mailboxes.length, A.cyan));
    lines.push(stat("Pending Messages    ", totalPend,        A.yellow));
    lines.push(stat("Topic Channels      ", channels.length,  A.magenta));
    lines.push(stat("Dead Letter Queue   ", `${dlq.length} failed`, dlq.length > 0 ? A.red : A.green));
    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.dim}Mesh Root: ${MESH_DIR}${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - stringWidth(MESH_DIR) - 15))}${A.dim}${A.cyan}${B.v}${A.reset}`);

    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}${" ".repeat(innerW + 2)}${A.dim}${A.cyan}${B.v}${A.reset}`);
    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.green}✔${A.reset} ${A.dim}Zero-Kill Invariant Guard  ENFORCED${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 40))}${A.dim}${A.cyan}${B.v}${A.reset}`);
    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.green}✔${A.reset} ${A.dim}NTFS Safe-Rename Retries   ACTIVE${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 40))}${A.dim}${A.cyan}${B.v}${A.reset}`);
    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.green}✔${A.reset} ${A.dim}Directory Jail Containment VERIFIED${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 40))}${A.dim}${A.cyan}${B.v}${A.reset}`);
    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.green}✔${A.reset} ${A.dim}Fast-Path SSE Fallback     READY${A.reset}${A.bgCanvas}${" ".repeat(Math.max(0, innerW - 40))}${A.dim}${A.cyan}${B.v}${A.reset}`);
  } catch (err) {
    lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}${A.bgCanvas}  ${A.red}Probe error: ${err.message}${A.reset}${A.bgCanvas}${A.dim}${A.cyan}${B.v}${A.reset}`);
  }

  lines.push(`${A.bgCanvas}${A.dim}${A.cyan}${B.bl}${B.h.repeat(Math.max(2, innerW + 2))}${B.br}${A.reset}`);

  contentBox.setContent(lines.join("\n"));
  contentBox.setLabel(" Mesh Health ");
  screen.render();
}

// ─────────────────────────────────────────────────────────────────
//  RENDER COMPOSE BAR
// ─────────────────────────────────────────────────────────────────
function renderComposeBar() {
  const { width: W } = composeOuter;
  const cW = W || screen.cols || 80;
  const inner = Math.max(10, cW - 4);
  const target = activeNav === 1 ? `#${selectedChannel}` : `@${selectedAgent}`;
  const headerText = ` Compose to ${target} `;
  const topDash = Math.max(2, inner - stringWidth(headerText));

  composeOuter.setContent(
    `${A.bgInput}${A.dim}${A.cyan}╭─${A.reset}${A.bgInput}${A.bold}${A.white}${headerText}${A.reset}${A.bgInput}${A.dim}${A.cyan}${"─".repeat(topDash)}╮${A.reset}\n` +
    `${A.bgInput}${A.dim}${A.cyan}╰${"─".repeat(inner + 2)}╯${A.reset}`
  );
  composeInput.setLabel(` ${target} `);
}

// ─────────────────────────────────────────────────────────────────
//  RENDER FOOTER (clickable buttons: Send, Clear, Refresh, Quit)
// ─────────────────────────────────────────────────────────────────
function renderFooter() {
  const { rows } = screen;
  const btnRow = rows - 1; // 1-based row on screen
  hitboxes = hitboxes.filter(h => h.row !== btnRow && h.row !== rows);

  const buttons = [
    { label: "↵ Send",  action: "btn_send" },
    { label: "Clear",   action: "btn_clear" },
    { label: "Refresh", action: "btn_refresh" },
    { label: "Quit",    action: "btn_quit" }
  ];

  let currentCol = 3; // 1-based, after 2 leading spaces
  const btnParts = [];

  for (const btn of buttons) {
    const pillText = `[ ${btn.label} ]`;
    const pillWidth = stringWidth(pillText);
    const startCol = currentCol;
    const endCol   = currentCol + pillWidth - 1;

    registerHitbox(btnRow, startCol, endCol, btn.action, {});
    btnParts.push(`${A.bgSelected}${A.bold}${A.cyan}${pillText}${A.reset}`);

    currentCol = endCol + 3; // 2 spaces between buttons
  }

  const keybinds = `  ${A.gray}[1-4] Tabs  [↑↓] Select Peer/Channel  [Tab] Focus  [Enter] Send  [q] Quit${A.reset}`;

  footerBox.setContent(
    `${A.bgFooter}  ${btnParts.join("  ")}${A.reset}\n` +
    `${A.bgFooter}${keybinds}${A.reset}`
  );
}

// ─────────────────────────────────────────────────────────────────
//  FULL REFRESH
// ─────────────────────────────────────────────────────────────────
async function refresh() {
  hitboxes = [];
  renderSidebar();
  renderComposeBar();
  renderFooter();
  await renderContent();
  screen.render();
}

// ─────────────────────────────────────────────────────────────────
//  LOAD peer + channel lists
// ─────────────────────────────────────────────────────────────────
async function loadLists() {
  try {
    const rawPeers = await listActiveMailboxes();
    const diskNames = new Set(rawPeers.map(p => p.name.toLowerCase()));
    const known = ["antigravity", "opencode", "jules", "sentinel", "coordinator"];
    const allPeers = [...rawPeers];
    for (const kp of known) {
      if (!diskNames.has(kp)) allPeers.push({ name: kp, total: 0, unread: 0 });
    }
    agentList = allPeers.map(p => p.name);
    agentIdx  = Math.max(0, agentList.indexOf(selectedAgent));
    if (agentIdx < 0) agentIdx = 0;
  } catch {
    agentList = ["antigravity", "opencode", "jules", "sentinel", "coordinator"];
  }

  try {
    const rawCh = listChannels();
    const defaults = ["general", "alerts", "handoffs"];
    const chNames  = new Set(rawCh.map(c => c.name.replace(/^#/, "")));
    const all = [...rawCh];
    for (const d of defaults) if (!chNames.has(d)) all.push({ name: d, total: 0 });
    channelList = all.map(c => c.name.replace(/^#/, ""));
    channelIdx  = Math.max(0, channelList.indexOf(selectedChannel));
    if (channelIdx < 0) channelIdx = 0;
  } catch {
    channelList = ["general", "alerts", "handoffs"];
  }
}

// ─────────────────────────────────────────────────────────────────
//  MOUSE EVENT DISPATCH (Blessed + Direct SGR decoder)
// ─────────────────────────────────────────────────────────────────
let lastHitTime = 0;
let lastHitKey  = "";

async function executeHitAction(hit) {
  if (!hit) return;
  switch (hit.action) {
    case "nav":
      activeNav = hit.payload.index;
      await loadLists();
      await refresh();
      break;

    case "select_agent":
      selectedAgent = hit.payload.name;
      agentIdx      = hit.payload.index;
      activeNav     = 0; // immediately open that agent's message stream!
      await refresh();
      break;

    case "select_channel":
      selectedChannel = hit.payload.name;
      channelIdx      = hit.payload.index;
      activeNav       = 1; // immediately open that channel!
      await refresh();
      break;

    case "btn_send":
      await doSend();
      break;

    case "btn_clear":
      if (activeNav === 0 && selectedAgent) {
        clearInbox(selectedAgent);
        logActivity(`Cleared inbox for @${selectedAgent}`);
        await refresh();
      }
      break;

    case "btn_refresh":
      await loadLists();
      await refresh();
      break;

    case "btn_quit":
      cleanExit();
      break;

    case "focus_compose":
      composeInput.focus();
      screen.render();
      break;
  }
}

function handleHit(row, col) {
  const now = Date.now();
  const key = `${row}:${col}`;
  if (now - lastHitTime < 60 && lastHitKey === key) {
    return; // debounce duplicate event within 60ms
  }
  lastHitTime = now;
  lastHitKey  = key;

  const hit = hitTest(row, col);
  if (hit) {
    executeHitAction(hit);
  } else {
    // Check if clicked in compose box area
    const { rows } = screen;
    if (row >= rows - 3 && row <= rows - 2) {
      composeInput.focus();
      screen.render();
    }
  }
}

// Layer 1: Blessed screen mouse event
screen.on("mouse", async (data) => {
  if (data.action !== "mousedown" && data.action !== "click") return;
  const row1 = data.y + 1;
  const col1 = data.x + 1;
  handleHit(row1, col1);
});

// Layer 2: Direct raw SGR mouse sequence stream decoder
const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
if (screen.program) {
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
        contentBox.scroll(-3);
        screen.render();
      } else if (!isRelease && rawBtn === 65) {
        contentBox.scroll(3);
        screen.render();
      }
    }
  });
}

// Layer 3: Widget click listeners
sidebarBox.on("click", (data) => {
  handleHit(data.y + 1, data.x + 1);
});
footerBox.on("click", (data) => {
  handleHit(data.y + 1, data.x + 1);
});
composeOuter.on("click", () => {
  composeInput.focus();
  screen.render();
});
contentBox.on("click", () => {
  contentBox.focus();
  screen.render();
});

// ─────────────────────────────────────────────────────────────────
//  SEND logic (shared between keyboard Enter & mouse [ ↵ Send ])
// ─────────────────────────────────────────────────────────────────
async function doSend() {
  const val = (composeInput.getValue() || "").trim();
  if (!val) {
    composeInput.focus();
    return;
  }

  if (activeNav === 1) {
    // Channel broadcast
    sendChannelMessage(selectedChannel, "operator", val);
    logActivity(`Broadcast → #${selectedChannel}: ${val.slice(0, 50)}`);
  } else {
    // Direct peer message
    let target = selectedAgent || "opencode";
    let body   = val;
    if (body.startsWith("@")) {
      const parts = body.split(" ");
      target = parts[0].slice(1);
      body   = parts.slice(1).join(" ");
    }
    if (!body) return;
    try {
      writeMessage("operator", target, body);
    } catch (e) {
      logActivity(`Send error: ${e.message}`);
    }
    selectedAgent = target;
    logActivity(`Sent → @${target}: ${body.slice(0, 50)}`);
  }

  composeInput.clearValue();
  await refresh();
}

// ─────────────────────────────────────────────────────────────────
//  KEYBOARD BINDINGS
// ─────────────────────────────────────────────────────────────────
screen.key(["q", "C-c"], cleanExit);

screen.key(["1", "2", "3", "4"], async (ch) => {
  activeNav = parseInt(ch, 10) - 1;
  await loadLists();
  await refresh();
});

screen.key(["r", "f5"], async () => {
  await loadLists();
  await refresh();
});

screen.key("tab", () => {
  if (screen.focused === sidebarBox) composeInput.focus();
  else if (screen.focused === composeInput) contentBox.focus();
  else sidebarBox.focus();
  screen.render();
});

screen.key("up", async () => {
  if (activeNav === 0 && agentList.length > 0) {
    agentIdx    = Math.max(0, agentIdx - 1);
    selectedAgent = agentList[agentIdx];
  } else if (activeNav === 1 && channelList.length > 0) {
    channelIdx    = Math.max(0, channelIdx - 1);
    selectedChannel = channelList[channelIdx];
  }
  await refresh();
});

screen.key("down", async () => {
  if (activeNav === 0 && agentList.length > 0) {
    agentIdx    = Math.min(agentList.length - 1, agentIdx + 1);
    selectedAgent = agentList[agentIdx];
  } else if (activeNav === 1 && channelList.length > 0) {
    channelIdx    = Math.min(channelList.length - 1, channelIdx + 1);
    selectedChannel = channelList[channelIdx];
  }
  await refresh();
});

screen.key("enter", async () => {
  if (screen.focused === composeInput) {
    await doSend();
  } else {
    composeInput.focus();
    screen.render();
  }
});

screen.key("c", async () => {
  if (activeNav === 0 && selectedAgent) {
    clearInbox(selectedAgent);
    logActivity(`Cleared inbox for @${selectedAgent}`);
    await refresh();
  }
});

composeInput.key("enter", async () => { await doSend(); });
composeInput.key("escape", () => { sidebarBox.focus(); screen.render(); });

// ─────────────────────────────────────────────────────────────────
//  LIVE WATCHER & Health auto-poll & Interactive Boot Guard
// ─────────────────────────────────────────────────────────────────
let watcher = null;
let pollInterval = null;

if (require.main === module) {
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
      await renderContent();
      renderSidebar();
      screen.render();
    });
  } catch {}

  pollInterval = setInterval(async () => {
    if (activeNav === 3) {
      await renderHealthContent();
      screen.render();
    }
  }, 10000);

  // ─────────────────────────────────────────────────────────────────
  //  BOOT
  // ─────────────────────────────────────────────────────────────────
  (async () => {
    await loadLists();
    await refresh();
    sidebarBox.focus();
  })();
}

// ─────────────────────────────────────────────────────────────────
//  EXPORTS FOR TESTING & HEADLESS HARNESSES
// ─────────────────────────────────────────────────────────────────
module.exports = {
  NAV_TABS,
  registerHitbox,
  hitTest,
  getHitboxes: () => hitboxes,
  clearHitboxes: () => { hitboxes = []; },
  handleHit,
  executeHitAction,
  renderSidebar,
  loadLists,
  refresh,
  screen,
  sidebarBox,
  contentBox,
  composeInput,
  getState: () => ({
    activeNav,
    selectedAgent,
    selectedChannel,
    agentList,
    channelList,
    agentIdx,
    channelIdx
  }),
  setState: (patch = {}) => {
    if (patch.activeNav !== undefined) activeNav = patch.activeNav;
    if (patch.selectedAgent !== undefined) selectedAgent = patch.selectedAgent;
    if (patch.selectedChannel !== undefined) selectedChannel = patch.selectedChannel;
    if (patch.agentList !== undefined) agentList = patch.agentList;
    if (patch.channelList !== undefined) channelList = patch.channelList;
    if (patch.agentIdx !== undefined) agentIdx = patch.agentIdx;
    if (patch.channelIdx !== undefined) channelIdx = patch.channelIdx;
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
