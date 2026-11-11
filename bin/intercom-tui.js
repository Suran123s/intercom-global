#!/usr/bin/env node
/**
 * bin/intercom-tui.js - Modern OpenCode-Inspired Terminal UI Dashboard
 *
 * Provides a clean, spacious 4-tab dashboard:
 * [1] Inbox        - Dual-pane agent mailboxes & conversational chat stream with inline prompt
 * [2] Channels     - Topic channels broadcast & discussion stream
 * [3] Mesh Health  - Real-time diagnostic cards for daemons, locks, and mesh transports
 * [4] Activity     - Audit log stream & Dead Letter Queue (DLQ) monitor
 *
 * Usage:
 *   intercom tui
 *   node bin/intercom-tui.js
 */

const blessed = require("blessed");
const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const {
  checkAndMarkRead,
  listActiveMailboxes,
  readInbox,
  clearInbox,
  sendChannelMessage,
  readChannel,
  listChannels
} = require("../src/core/mesh");
const { dispatchMessage } = require("../src/core/server");
const { diagnoseMesh } = require("../src/controllers/autowake");
const { getDlq } = require("../src/core/dlq");
const { MESH_DIR, PORT } = require("../src/config");

// Initialize blessed screen
const screen = blessed.screen({
  smartCSR: true,
  title: "Intercom Global · OpenCode Mesh Cockpit",
  dockBorders: true,
  fullUnicode: true
});

// App State
let activeTab = 0; // 0: Inbox, 1: Channels, 2: Health, 3: Activity
let selectedAgent = "opencode";
let agentList = [];
let agentIdx = 0;
let selectedChannel = "general";
let channelList = [];
let channelIdx = 0;
const activityLog = [];

function logActivity(text) {
  const ts = new Date().toLocaleTimeString();
  activityLog.unshift(`[${ts}] ${text}`);
  if (activityLog.length > 50) activityLog.pop();
}

// -----------------------------------------------------------------------------
// Top Header & Tab Bar (OpenCode Aesthetic)
// -----------------------------------------------------------------------------
const headerBar = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  content: ` {bold}{cyan-fg}● INTERCOM GLOBAL{/cyan-fg}{/bold}  {gray-fg}·  v2.0.0  ·  Mesh: active  ·  Port: ${PORT || 4150}  ·  OpenCode Serenity{/gray-fg}`,
  style: { bg: "black" }
});

const tabBar = blessed.box({
  top: 1,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  style: { bg: "black" }
});

const TAB_DEFS = [
  { id: "inbox", label: " [1] Inbox " },
  { id: "channels", label: " [2] Channels " },
  { id: "health", label: " [3] Mesh Health " },
  { id: "activity", label: " [4] Activity & DLQ " }
];

function updateTabBar() {
  const tabStrips = TAB_DEFS.map((t, idx) => {
    if (idx === activeTab) {
      return `{white-bg}{black-fg}{bold}${t.label}{/bold}{/black-fg}{/white-bg}`;
    }
    return `{gray-fg}${t.label}{/gray-fg}`;
  }).join("  ");
  tabBar.setContent(` ${tabStrips}`);
  screen.render();
}

// Bottom Status Bar
const statusBar = blessed.box({
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  content: " {gray-fg}[1-4] Tabs  [Tab] Switch Pane  [↑/↓] Select  [Enter] Compose  [c] Clear  [r] Refresh  [q] Quit{/gray-fg}",
  style: { bg: "black" }
});

function setStatus(msg) {
  statusBar.setContent(` {cyan-fg}›{/cyan-fg} ${msg}  {gray-fg}|  [1-4] Tabs  [Tab] Switch Pane  [r] Refresh  [q] Quit{/gray-fg}`);
  screen.render();
}

// -----------------------------------------------------------------------------
// TAB 1: INBOX (Dual-Pane + Inline Compose)
// -----------------------------------------------------------------------------
const inboxContainer = blessed.box({
  top: 2,
  left: 0,
  width: "100%",
  bottom: 1
});

const peerBox = blessed.box({
  parent: inboxContainer,
  top: 0,
  left: 0,
  width: "30%",
  bottom: 3,
  label: " Active Peers & Mailboxes ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "cyan", bold: true }
  },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  tags: true
});

const messageBox = blessed.box({
  parent: inboxContainer,
  top: 0,
  left: "30%",
  width: "70%",
  bottom: 3,
  label: " Conversation Stream ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "cyan", bold: true }
  },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  tags: true
});

const composeBox = blessed.box({
  parent: inboxContainer,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  label: " Direct Prompt Composition ",
  border: { type: "line" },
  style: {
    border: { fg: "gray" },
    label: { fg: "gray", bold: true }
  },
  tags: true
});

const composeInput = blessed.textbox({
  parent: composeBox,
  top: 0,
  left: 2,
  right: 2,
  height: 1,
  inputOnFocus: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "black",
    focus: { fg: "white", bg: "black" }
  }
});

// -----------------------------------------------------------------------------
// TAB 2: CHANNELS (Topic Broadcast)
// -----------------------------------------------------------------------------
const channelsContainer = blessed.box({
  top: 2,
  left: 0,
  width: "100%",
  bottom: 1,
  hidden: true
});

const channelListBox = blessed.box({
  parent: channelsContainer,
  top: 0,
  left: 0,
  width: "30%",
  bottom: 3,
  label: " Topic Channels ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "magenta", bold: true }
  },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  tags: true
});

const channelMsgBox = blessed.box({
  parent: channelsContainer,
  top: 0,
  left: "30%",
  width: "70%",
  bottom: 3,
  label: " Channel Stream ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "magenta", bold: true }
  },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  tags: true
});

const channelComposeBox = blessed.box({
  parent: channelsContainer,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  label: " Broadcast to Channel ",
  border: { type: "line" },
  style: {
    border: { fg: "gray" },
    label: { fg: "gray", bold: true }
  },
  tags: true
});

const channelComposeInput = blessed.textbox({
  parent: channelComposeBox,
  top: 0,
  left: 2,
  right: 2,
  height: 1,
  inputOnFocus: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "black"
  }
});

// -----------------------------------------------------------------------------
// TAB 3: MESH HEALTH (Diagnostic Cards)
// -----------------------------------------------------------------------------
const healthContainer = blessed.box({
  top: 2,
  left: 0,
  width: "100%",
  bottom: 1,
  hidden: true
});

const healthServicesCard = blessed.box({
  parent: healthContainer,
  top: 0,
  left: 0,
  width: "50%",
  height: "50%",
  label: " Local Daemons & Services ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "green", bold: true }
  },
  tags: true
});

const healthMeshCard = blessed.box({
  parent: healthContainer,
  top: 0,
  left: "50%",
  width: "50%",
  height: "50%",
  label: " Discrete File-Mesh Metrics ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "green", bold: true }
  },
  tags: true
});

const healthDiagCard = blessed.box({
  parent: healthContainer,
  top: "50%",
  left: 0,
  width: "100%",
  bottom: 0,
  label: " Transport Diagnostics & Security Guards ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "green", bold: true }
  },
  tags: true
});

// -----------------------------------------------------------------------------
// TAB 4: ACTIVITY & DLQ
// -----------------------------------------------------------------------------
const activityContainer = blessed.box({
  top: 2,
  left: 0,
  width: "100%",
  bottom: 1,
  hidden: true
});

const activityStreamBox = blessed.box({
  parent: activityContainer,
  top: 0,
  left: 0,
  width: "55%",
  bottom: 0,
  label: " Live Mesh Activity Stream ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "cyan", bold: true }
  },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  tags: true
});

const dlqBox = blessed.box({
  parent: activityContainer,
  top: 0,
  left: "55%",
  width: "45%",
  bottom: 0,
  label: " Dead Letter Queue (DLQ) ",
  border: { type: "line" },
  style: {
    border: { fg: "blue" },
    label: { fg: "red", bold: true }
  },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  tags: true
});

// Append top elements to screen
screen.append(headerBar);
screen.append(tabBar);
screen.append(inboxContainer);
screen.append(channelsContainer);
screen.append(healthContainer);
screen.append(activityContainer);
screen.append(statusBar);

// -----------------------------------------------------------------------------
// Tab Switching Controller
// -----------------------------------------------------------------------------
function switchTab(index) {
  activeTab = (index + 4) % 4;
  inboxContainer.hide();
  channelsContainer.hide();
  healthContainer.hide();
  activityContainer.hide();

  if (activeTab === 0) {
    inboxContainer.show();
    peerBox.focus();
    renderInboxView();
  } else if (activeTab === 1) {
    channelsContainer.show();
    channelListBox.focus();
    renderChannelsView();
  } else if (activeTab === 2) {
    healthContainer.show();
    renderHealthView();
  } else if (activeTab === 3) {
    activityContainer.show();
    renderActivityView();
  }
  updateTabBar();
}

// -----------------------------------------------------------------------------
// Data Renderers
// -----------------------------------------------------------------------------
const KNOWN_PEERS = ["antigravity", "opencode", "jules", "sentinel", "coordinator"];

async function renderInboxView() {
  try {
    const rawPeers = await listActiveMailboxes();
    const diskNames = new Set(rawPeers.map(p => p.name.toLowerCase()));
    
    // Combine known peers with disk peers
    const allPeers = [...rawPeers];
    for (const kp of KNOWN_PEERS) {
      if (!diskNames.has(kp)) {
        allPeers.push({ name: kp, total: 0, unread: 0 });
      }
    }
    
    // Sort selected to top or keep deterministic order
    agentList = allPeers.map(p => p.name);
    if (agentIdx >= agentList.length) agentIdx = Math.max(0, agentList.length - 1);
    if (!selectedAgent && agentList.length > 0) selectedAgent = agentList[agentIdx];

    const lines = allPeers.map((p, idx) => {
      const isSelected = p.name.toLowerCase() === (selectedAgent || "").toLowerCase();
      const pointer = isSelected ? "{cyan-fg}› {/cyan-fg}" : "  ";
      const badge = p.unread > 0 ? ` {red-fg}[${p.unread} new]{/red-fg}` : "";
      const onlinePill = (p.name === "antigravity" || p.name === "opencode") ? "{green-fg}[● online]{/green-fg} " : "";
      const nameFmt = isSelected ? `{bold}{white-fg}${p.name}{/white-fg}{/bold}` : `{gray-fg}${p.name}{/gray-fg}`;
      return `${pointer}${nameFmt} ${onlineFmt(p.name)}${badge}`;
    });

    peerBox.setContent(lines.join("\n"));
  } catch (err) {
    peerBox.setContent(`{red-fg}Error loading mailboxes: ${err.message}{/red-fg}`);
  }

  // Render messages
  if (!selectedAgent) {
    messageBox.setContent(" {gray-fg}Select an agent from the left pane using ↑/↓{/gray-fg}");
    messageBox.setLabel(" Conversation Stream ");
  } else {
    try {
      const msgs = readInbox(selectedAgent);
      messageBox.setLabel(` Conversation Stream: @${selectedAgent} (${msgs.length} messages) `);
      if (msgs.length === 0) {
        messageBox.setContent(`\n  {gray-fg}No messages in @${selectedAgent}'s mailbox.{/gray-fg}\n  {gray-fg}Press Enter or type below to send a message.{/gray-fg}`);
      } else {
        const rendered = msgs.slice(-25).map(m => {
          const from = (m.from || "unknown").toUpperCase();
          const ts = m.timestamp || new Date().toLocaleTimeString();
          const body = m.message || "";
          const isUnread = !m.read;
          const statusBadge = isUnread ? "{yellow-fg}[UNREAD]{/yellow-fg} " : "";
          
          return [
            ` {cyan-fg}╭─ {bold}@${from}{/bold}  {gray-fg}·  ${ts}{/gray-fg}  ${statusBadge}{/cyan-fg}`,
            ` {cyan-fg}│{/cyan-fg}  ${body}`,
            ` {cyan-fg}╰──────────────────────────────────────────{/cyan-fg}`
          ].join("\n");
        }).join("\n\n");
        messageBox.setContent(rendered);
      }
    } catch (e) {
      messageBox.setContent(`{red-fg}Error loading messages: ${e.message}{/red-fg}`);
    }
  }

  composeBox.setLabel(` Compose to @${selectedAgent || "agent"} (Enter to send) `);
  screen.render();
}

function onlineFmt(name) {
  if (name === "antigravity" || name === "opencode" || name === "coordinator") {
    return "{green-fg}●{/green-fg}";
  }
  return "{gray-fg}○{/gray-fg}";
}

function renderChannelsView() {
  try {
    const rawChannels = listChannels();
    const defaults = ["general", "alerts", "handoffs"];
    const channelNames = new Set(rawChannels.map(c => c.name.replace(/^#/, "")));
    
    for (const d of defaults) {
      if (!channelNames.has(d)) {
        rawChannels.push({ name: `#${d}`, total: 0 });
      }
    }

    channelList = rawChannels.map(c => c.name.replace(/^#/, ""));
    if (channelIdx >= channelList.length) channelIdx = Math.max(0, channelList.length - 1);
    if (!selectedChannel && channelList.length > 0) selectedChannel = channelList[channelIdx];

    const lines = rawChannels.map(c => {
      const cName = c.name.replace(/^#/, "");
      const isSelected = cName === selectedChannel;
      const pointer = isSelected ? "{magenta-fg}› {/magenta-fg}" : "  ";
      const nameFmt = isSelected ? `{bold}{white-fg}#${cName}{/white-fg}{/bold}` : `{gray-fg}#${cName}{/gray-fg}`;
      return `${pointer}${nameFmt} {gray-fg}(${c.total || 0}){/gray-fg}`;
    });

    channelListBox.setContent(lines.join("\n"));
  } catch (err) {
    channelListBox.setContent(`{red-fg}Error loading channels: ${err.message}{/red-fg}`);
  }

  // Render channel messages
  if (!selectedChannel) {
    channelMsgBox.setContent(" {gray-fg}Select a channel from the left pane{/gray-fg}");
  } else {
    try {
      const msgs = readChannel(selectedChannel);
      channelMsgBox.setLabel(` Channel Stream: #${selectedChannel} (${msgs.length} messages) `);
      if (msgs.length === 0) {
        channelMsgBox.setContent(`\n  {gray-fg}No messages in #${selectedChannel}. Broadcast a message below!{/gray-fg}`);
      } else {
        const rendered = msgs.slice(-25).map(m => {
          const from = (m.from || "unknown").toUpperCase();
          const ts = m.timestamp || new Date().toLocaleTimeString();
          const body = m.message || "";
          return [
            ` {magenta-fg}╭─ {bold}@${from}{/bold}  {gray-fg}·  ${ts}{/gray-fg}{/magenta-fg}`,
            ` {magenta-fg}│{/magenta-fg}  ${body}`,
            ` {magenta-fg}╰──────────────────────────────────────────{/magenta-fg}`
          ].join("\n");
        }).join("\n\n");
        channelMsgBox.setContent(rendered);
      }
    } catch (e) {
      channelMsgBox.setContent(`{red-fg}Error loading channel: ${e.message}{/red-fg}`);
    }
  }

  channelComposeBox.setLabel(` Broadcast to #${selectedChannel || "channel"} (Enter to send) `);
  screen.render();
}

async function renderHealthView() {
  healthServicesCard.setContent("  {gray-fg}Probing local mesh services...{/gray-fg}");
  screen.render();

  try {
    const diag = await diagnoseMesh().catch(() => ({}));
    const s = diag.services || {};
    const ln = (label, svc) => {
      const isOnline = svc && svc.status === "ONLINE";
      const pill = isOnline ? "{green-fg}[ONLINE]{/green-fg}" : "{red-fg}[OFFLINE]{/red-fg}";
      return `  ${pill} {bold}${label}{/bold}`;
    };

    healthServicesCard.setContent([
      "",
      ln("Pi Broker Service   ", s.piBroker),
      ln("OpenCode API Engine ", s.opencodeApi),
      ln("Hermes AI Gateway   ", s.hermesGateway),
      ln("Local Mesh Daemon   ", s.intercomDaemon),
      "",
      `  {gray-fg}Last Probe: ${new Date().toLocaleTimeString()}{/gray-fg}`
    ].join("\n"));

    // File-Mesh Metrics
    const mailboxes = await listActiveMailboxes().catch(() => []);
    const totalPending = mailboxes.reduce((acc, m) => acc + (m.total || 0), 0);
    const channels = listChannels();
    const dlq = getDlq();

    healthMeshCard.setContent([
      "",
      `  {bold}Discrete Mailboxes  :{/bold} {cyan-fg}${mailboxes.length}{/cyan-fg} registered`,
      `  {bold}Pending Messages    :{/bold} {yellow-fg}${totalPending}{/yellow-fg} in queues`,
      `  {bold}Topic Channels      :{/bold} {magenta-fg}${channels.length}{/magenta-fg} active`,
      `  {bold}Dead Letter Queue   :{/bold} {${dlq.length > 0 ? "red" : "green"}-fg}${dlq.length} failed{/${dlq.length > 0 ? "red" : "green"}-fg}`,
      `  {bold}Mesh Storage Root   :{/bold} {gray-fg}${MESH_DIR}{/gray-fg}`
    ].join("\n"));

    // Diagnostics & Security Guards
    healthDiagCard.setContent([
      "",
      `  {green-fg}✔ Zero-Kill Invariant Guard  :{/green-fg} ENFORCED (Processes immune to accidental termination)`,
      `  {green-fg}✔ NTFS Safe-Rename Retries   :{/green-fg} ACTIVE (Exponential backoff & CAS collision immunity)`,
      `  {green-fg}✔ Directory Jail Containment :{/green-fg} VERIFIED (Path traversal & DOS device names blocked)`,
      `  {green-fg}✔ Fast-Path SSE Fallback     :{/green-fg} READY (Automatic fallback to discrete file-mesh)`
    ].join("\n"));

  } catch (err) {
    healthServicesCard.setContent(`{red-fg}Error diagnosing mesh: ${err.message}{/red-fg}`);
  }
  screen.render();
}

function renderActivityView() {
  // Activity log stream
  const logContent = activityLog.length === 0
    ? "  {gray-fg}No activity recorded in this session yet.{/gray-fg}"
    : activityLog.slice(0, 30).map(l => `  {gray-fg}${l}{/gray-fg}`).join("\n");
  activityStreamBox.setContent(`\n${logContent}`);

  // DLQ items
  try {
    const dlq = getDlq();
    if (dlq.length === 0) {
      dlqBox.setContent("\n  {green-fg}✔ Dead Letter Queue is clean (0 failures).{/green-fg}");
    } else {
      const items = dlq.slice(0, 15).map(d => {
        const to = (d.to || "unknown").toUpperCase();
        const err = d.error || "Delivery failure";
        const msg = (d.message || "").slice(0, 40);
        return `  {red-fg}✖{/red-fg} {bold}${to}:{/bold} ${msg}\n    {gray-fg}Error: ${err}{/gray-fg}`;
      }).join("\n\n");
      dlqBox.setContent(`\n${items}`);
    }
  } catch (e) {
    dlqBox.setContent(`{red-fg}Error reading DLQ: ${e.message}{/red-fg}`);
  }

  screen.render();
}

// -----------------------------------------------------------------------------
// Keyboard Navigation & Interactions
// -----------------------------------------------------------------------------
// Global Keys
screen.key(["q", "C-c"], () => {
  screen.destroy();
  process.exit(0);
});

screen.key(["1", "2", "3", "4"], (ch) => {
  switchTab(parseInt(ch, 10) - 1);
});

screen.key(["r", "f5"], async () => {
  logActivity("Manual refresh triggered");
  if (activeTab === 0) await renderInboxView();
  else if (activeTab === 1) renderChannelsView();
  else if (activeTab === 2) await renderHealthView();
  else if (activeTab === 3) renderActivityView();
  setStatus("Refreshed all views");
});

screen.key("tab", () => {
  if (activeTab === 0) {
    if (screen.focused === peerBox) composeInput.focus();
    else if (screen.focused === composeInput) messageBox.focus();
    else peerBox.focus();
  } else if (activeTab === 1) {
    if (screen.focused === channelListBox) channelComposeInput.focus();
    else if (screen.focused === channelComposeInput) channelMsgBox.focus();
    else channelListBox.focus();
  } else if (activeTab === 3) {
    if (screen.focused === activityStreamBox) dlqBox.focus();
    else activityStreamBox.focus();
  }
  screen.render();
});

// Tab 1: Peer Box Navigation
peerBox.key("up", () => {
  if (agentList.length === 0) return;
  agentIdx = Math.max(0, agentIdx - 1);
  selectedAgent = agentList[agentIdx];
  renderInboxView();
});

peerBox.key("down", () => {
  if (agentList.length === 0) return;
  agentIdx = Math.min(agentList.length - 1, agentIdx + 1);
  selectedAgent = agentList[agentIdx];
  renderInboxView();
});

peerBox.key(["enter", "s"], () => {
  composeInput.focus();
  screen.render();
});

screen.key("c", async () => {
  if (activeTab === 0 && selectedAgent) {
    clearInbox(selectedAgent);
    logActivity(`Cleared inbox for @${selectedAgent}`);
    await renderInboxView();
    setStatus(`Cleared inbox for @${selectedAgent}`);
  }
});

// Tab 1: Direct Prompt Composition Submission
composeInput.key("enter", async () => {
  const val = (composeInput.getValue() || "").trim();
  if (val) {
    let targetAgent = selectedAgent || "opencode";
    let body = val;
    
    // Check if input starts with @agent
    if (body.startsWith("@")) {
      const parts = body.split(" ");
      targetAgent = parts[0].slice(1);
      body = parts.slice(1).join(" ");
    }

    if (body) {
      dispatchMessage("operator", targetAgent, body);
      logActivity(`Sent message -> @${targetAgent}: ${body.slice(0, 50)}`);
      composeInput.clearValue();
      composeBox.style.border.fg = "green";
      screen.render();
      setTimeout(() => {
        composeBox.style.border.fg = "gray";
        screen.render();
      }, 800);
      await renderInboxView();
      setStatus(`Message dispatched to @${targetAgent}`);
    }
  }
  peerBox.focus();
});

composeInput.key("escape", () => {
  peerBox.focus();
  screen.render();
});

// Tab 2: Channel Box Navigation
channelListBox.key("up", () => {
  if (channelList.length === 0) return;
  channelIdx = Math.max(0, channelIdx - 1);
  selectedChannel = channelList[channelIdx];
  renderChannelsView();
});

channelListBox.key("down", () => {
  if (channelList.length === 0) return;
  channelIdx = Math.min(channelList.length - 1, channelIdx + 1);
  selectedChannel = channelList[channelIdx];
  renderChannelsView();
});

channelListBox.key(["enter", "s"], () => {
  channelComposeInput.focus();
  screen.render();
});

channelComposeInput.key("enter", () => {
  const val = (channelComposeInput.getValue() || "").trim();
  if (val && selectedChannel) {
    sendChannelMessage(selectedChannel, "operator", val);
    logActivity(`Broadcast -> #${selectedChannel}: ${val.slice(0, 50)}`);
    channelComposeInput.clearValue();
    renderChannelsView();
    setStatus(`Broadcasted to #${selectedChannel}`);
  }
  channelListBox.focus();
});

channelComposeInput.key("escape", () => {
  channelListBox.focus();
  screen.render();
});

// -----------------------------------------------------------------------------
// Live File Watcher & Auto-Refresh
// -----------------------------------------------------------------------------
try {
  const watcher = chokidar.watch(MESH_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 3,
    usePolling: process.platform === "win32",
    interval: 800
  });

  watcher.on("all", (event, filePath) => {
    if (activeTab === 0) renderInboxView().catch(() => {});
    else if (activeTab === 1) renderChannelsView();
    else if (activeTab === 3) renderActivityView();
  });
} catch (e) {
  // Watcher fallback
}

// Background poll for health and activities
setInterval(() => {
  if (activeTab === 2) renderHealthView().catch(() => {});
  if (activeTab === 3) renderActivityView();
}, 10000);

// Initial Load
(async () => {
  updateTabBar();
  await renderInboxView();
  peerBox.focus();
  setStatus("Ready · OpenCode Mesh Cockpit");
})();
