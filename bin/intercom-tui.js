#!/usr/bin/env node
// bin/intercom-tui.js - Live Terminal UI Dashboard (blessed)
// Usage: intercom tui  (or)  node bin/intercom-tui.js

const blessed = require("blessed");
const fs = require("fs");
const path = require("path");
const { checkAndMarkRead, listActiveMailboxes, readInbox, clearInbox, sendChannelMessage, readChannel, listChannels } = require("../src/core/mesh");
const { dispatchMessage } = require("../src/core/server");
const { diagnoseMesh } = require("../src/controllers/autowake");
const { getDlq } = require("../src/core/dlq");
const { MESH_DIR } = require("../src/config");
const chokidar = require("chokidar");

// Screen
const screen = blessed.screen({ smartCSR: true, title: "Intercom Global", dockBorders: true, fullUnicode: true });

// Status bar
const statusBar = blessed.box({ top: 0, left: 0, width: "100%", height: 1, content: " Intercom Global  |  [q] Quit  [r] Refresh  [s] Send  [c] Clear  [Tab] Focus  [up/dn] Select Agent", style: { bg: "blue", fg: "white", bold: true } });

// Agent panel (left)
const agentBox = blessed.box({ top: 1, left: 0, width: "28%", height: "45%", label: " Agents ", border: { type: "line" }, style: { border: { fg: "cyan" }, label: { fg: "cyan", bold: true } }, scrollable: true, alwaysScroll: true, mouse: true, keys: true, tags: true });

// Message panel (middle)
const messageBox = blessed.box({ top: 1, left: "28%", width: "44%", height: "45%", label: " Inbox / Messages ", border: { type: "line" }, style: { border: { fg: "yellow" }, label: { fg: "yellow", bold: true } }, scrollable: true, alwaysScroll: true, mouse: true, keys: true, tags: true });

// Health panel (right)
const healthBox = blessed.box({ top: 1, left: "72%", width: "28%", height: "45%", label: " Mesh Health ", border: { type: "line" }, style: { border: { fg: "green" }, label: { fg: "green", bold: true } }, scrollable: true, alwaysScroll: true, mouse: true, tags: true });

// Channel panel (bottom left)
const channelBox = blessed.box({ top: "46%", left: 0, width: "50%", height: "43%", label: " Topic Channels ", border: { type: "line" }, style: { border: { fg: "magenta" }, label: { fg: "magenta", bold: true } }, scrollable: true, alwaysScroll: true, mouse: true, tags: true });

// DLQ / Activity log (bottom right)
const dlqBox = blessed.box({ top: "46%", left: "50%", width: "50%", height: "43%", label: " DLQ & Activity ", border: { type: "line" }, style: { border: { fg: "red" }, label: { fg: "red", bold: true } }, scrollable: true, alwaysScroll: true, mouse: true, tags: true });

// Bottom bar
const bottomBar = blessed.box({ bottom: 0, left: 0, width: "100%", height: 1, style: { bg: "black", fg: "gray" }, tags: true });

screen.append(statusBar);
screen.append(agentBox);
screen.append(messageBox);
screen.append(healthBox);
screen.append(channelBox);
screen.append(dlqBox);
screen.append(bottomBar);

// State
let selectedAgent = null;
let agentList = [];
let agentIdx = 0;
const activityLog = [];
const panels = [agentBox, messageBox, healthBox, channelBox, dlqBox];
let focusIndex = 0;

function log(msg) {
  activityLog.unshift(new Date().toLocaleTimeString() + " " + msg);
  if (activityLog.length > 40) activityLog.pop();
}

function setStatus(msg) {
  bottomBar.setContent(" " + msg);
  screen.render();
}

// Renderers
function renderAgents() {
  const peers = listActiveMailboxes();
  agentList = peers.map(p => p.name);
  if (peers.length === 0) { agentBox.setContent("{gray-fg}No mailboxes yet{/gray-fg}"); screen.render(); return; }
  const lines = peers.map(p => {
    const sel = p.name === selectedAgent;
    const unreadMark = p.unread > 0 ? `{red-fg} [${p.unread} new]{/red-fg}` : "";
    return `${sel ? "{cyan-fg}> " : "  "}${sel ? "{bold}" : ""}${p.name.toUpperCase()}${sel ? "{/bold}" : ""}${unreadMark}`;
  });
  agentBox.setContent(lines.join("\n"));
  screen.render();
}

function renderMessages() {
  if (!selectedAgent) { messageBox.setContent("{gray-fg}Select an agent with up/down + Enter{/gray-fg}"); screen.render(); return; }
  const msgs = readInbox(selectedAgent);
  messageBox.setLabel(` Inbox: ${selectedAgent.toUpperCase()} (${msgs.length} msgs) `);
  if (msgs.length === 0) { messageBox.setContent("{gray-fg}Empty inbox{/gray-fg}"); screen.render(); return; }
  const lines = [...msgs].reverse().map(m => {
    const statusStr = m.status ? ` [${m.status}]` : "";
    return [
      `{${m.read ? "gray" : "white"}-fg}{bold}From: ${(m.from||"?").toUpperCase()}${statusStr}{/bold}{/${m.read ? "gray" : "white"}-fg}`,
      `  {gray-fg}${m.timestamp||""}{/gray-fg}`,
      `  ${m.message||""}`,
      ""
    ].join("\n");
  });
  messageBox.setContent(lines.join("\n"));
  messageBox.setScrollPerc(0);
  screen.render();
}

function renderHealth() {
  healthBox.setContent("{gray-fg}Checking...{/gray-fg}");
  screen.render();
  diagnoseMesh().then(h => {
    const s = h.services || {};
    const ln = (label, svc) => `${svc && svc.status === "ONLINE" ? "{green-fg}[ON]{/green-fg}" : "{red-fg}[OF]{/red-fg}"} ${label}`;
    const dlq = getDlq();
    healthBox.setContent([
      ln("Pi Broker  ", s.piBroker),
      ln("OpenCode   ", s.opencodeApi),
      ln("Hermes     ", s.hermesGateway),
      ln("Daemon     ", s.intercomDaemon),
      "",
      `{gray-fg}Checked: ${new Date().toLocaleTimeString()}{/gray-fg}`,
      "",
      `DLQ: {${dlq.length > 0 ? "red" : "green"}-fg}${dlq.length} failed{/${dlq.length > 0 ? "red" : "green"}-fg}`
    ].join("\n"));
    screen.render();
  }).catch(() => { healthBox.setContent("{red-fg}Health probe error{/red-fg}"); screen.render(); });
}

function renderChannels() {
  const channels = listChannels();
  if (channels.length === 0) { channelBox.setContent("{gray-fg}No channels.\nUse: intercom channel send --channel #general --from me --msg hello{/gray-fg}"); screen.render(); return; }
  const lines = channels.flatMap(c => {
    const msgs = readChannel(c.name);
    const last3 = msgs.slice(-3).map(m => `  {gray-fg}${(m.from||"?").toUpperCase()}:{/gray-fg} ${(m.message||"").slice(0,55)}`);
    return [`{magenta-fg}#${c.name}{/magenta-fg} {gray-fg}(${c.total}){/gray-fg}`, ...last3, ""];
  });
  channelBox.setContent(lines.join("\n"));
  screen.render();
}

function renderDLQ() {
  const dlq = getDlq();
  const content = [
    "{bold}Activity:{/bold}",
    ...activityLog.slice(0, 8).map(l => `{gray-fg}${l}{/gray-fg}`),
    "",
    `{bold}{red-fg}DLQ: ${dlq.length} failed{/red-fg}{/bold}`,
    ...(dlq.length === 0
      ? ["{gray-fg}  Clean{/gray-fg}"]
      : dlq.slice(0,5).map(d => `{red-fg}x{/red-fg} ${(d.to||"?").toUpperCase()}: ${(d.message||"").slice(0,40)}`))
  ];
  dlqBox.setContent(content.join("\n"));
  screen.render();
}

function renderAll() {
  renderAgents();
  renderMessages();
  renderChannels();
  renderDLQ();
}

function selectAgent(name) {
  selectedAgent = name;
  log("Selected: " + name.toUpperCase());
  renderAgents();
  renderMessages();
  renderDLQ();
}

// Keyboard
screen.key(["q", "C-c"], () => { screen.destroy(); process.exit(0); });
screen.key(["r", "f5"], () => { log("Manual refresh"); renderAll(); renderHealth(); setStatus("Refreshed " + new Date().toLocaleTimeString()); });
screen.key("tab", () => { focusIndex = (focusIndex + 1) % panels.length; panels[focusIndex].focus(); screen.render(); });

agentBox.key("up", () => { if (agentList.length === 0) return; agentIdx = Math.max(0, agentIdx - 1); selectAgent(agentList[agentIdx]); });
agentBox.key("down", () => { if (agentList.length === 0) return; agentIdx = Math.min(agentList.length - 1, agentIdx + 1); selectAgent(agentList[agentIdx]); });
agentBox.key("enter", () => { if (agentList[agentIdx]) selectAgent(agentList[agentIdx]); });

screen.key("c", () => {
  if (!selectedAgent) { setStatus("Select an agent first"); return; }
  clearInbox(selectedAgent);
  log("Cleared " + selectedAgent.toUpperCase());
  renderMessages(); renderAgents();
  setStatus("Cleared " + selectedAgent.toUpperCase() + " inbox");
});

screen.key("s", () => {
  const form = blessed.form({ top: "center", left: "center", width: 60, height: 14, label: " Send Message ", border: { type: "line" }, style: { border: { fg: "yellow" } }, keys: true, mouse: true });
  blessed.text({ parent: form, top: 1, left: 2, content: "From:" });
  const fromInput = blessed.textbox({ parent: form, top: 2, left: 2, width: 54, height: 1, inputOnFocus: true, border: { type: "line" }, style: { fg: "white", bg: "black" } });
  blessed.text({ parent: form, top: 4, left: 2, content: `To (agent — default: ${selectedAgent || "opencode"}):` });
  const toInput = blessed.textbox({ parent: form, top: 5, left: 2, width: 54, height: 1, inputOnFocus: true, border: { type: "line" }, style: { fg: "white", bg: "black" }, value: selectedAgent || "" });
  blessed.text({ parent: form, top: 7, left: 2, content: "Message:" });
  const msgInput = blessed.textbox({ parent: form, top: 8, left: 2, width: 54, height: 1, inputOnFocus: true, border: { type: "line" }, style: { fg: "white", bg: "black" } });
  const sendBtn = blessed.button({ parent: form, bottom: 0, right: 10, width: 10, height: 1, content: "  Send  ", style: { fg: "white", bg: "green" }, mouse: true });
  const cancelBtn = blessed.button({ parent: form, bottom: 0, right: 0, width: 10, height: 1, content: " Cancel ", style: { fg: "white", bg: "red" }, mouse: true });
  screen.append(form);
  fromInput.focus();
  screen.render();

  function doSend() {
    const from = (fromInput.getValue() || "dashboard").trim();
    const to = (toInput.getValue() || selectedAgent || "opencode").trim();
    const msg = (msgInput.getValue() || "").trim();
    if (msg) {
      dispatchMessage(from, to, msg);
      log("Sent -> " + to.toUpperCase() + ": " + msg.slice(0, 40));
      renderAll();
      setStatus("Sent to " + to.toUpperCase());
    }
    form.destroy(); screen.render();
  }

  sendBtn.on("press", doSend);
  cancelBtn.on("press", () => { form.destroy(); screen.render(); });
  form.key("escape", () => { form.destroy(); screen.render(); });
});

// File watcher
try {
  const watcher = chokidar.watch(MESH_DIR, { persistent: true, ignoreInitial: true, depth: 2, usePolling: process.platform === "win32", interval: 600 });
  watcher.on("change", filePath => {
    const agent = path.basename(filePath, ".json").toLowerCase();
    log("Changed: " + agent);
    renderAgents();
    if (selectedAgent && agent === selectedAgent.toLowerCase()) renderMessages();
    renderChannels(); renderDLQ();
  });
  watcher.on("add", () => { renderAgents(); renderChannels(); });
} catch(e) {}

// Initial render
renderAll();
renderHealth();
if (agentList.length > 0) selectAgent(agentList[0]);
setStatus("Ready — [s] Send  [c] Clear  [r] Refresh  [Tab] Focus  [q] Quit");

// Periodic refresh
setInterval(() => { renderHealth(); renderDLQ(); }, 15000);
setInterval(() => { renderAgents(); if (selectedAgent) renderMessages(); renderChannels(); }, 3000);

agentBox.focus();
screen.render();
