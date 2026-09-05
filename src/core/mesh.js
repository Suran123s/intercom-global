// src/core/mesh.js - Durable File Mesh Mailbox Operations
const fs = require("fs");
const path = require("path");
const { MESH_DIR } = require("../config");

function sanitizeName(str, fallback = "default") {
  if (!str || typeof str !== "string") return fallback;
  const safeBasename = path.basename(str.replace(/\\/g, "/"));
  const clean = safeBasename.replace(/[^a-zA-Z0-9_#-]/g, "").toLowerCase();
  return clean || fallback;
}

function getInboxFile(agentName) {
  const clean = sanitizeName(agentName, "default");
  if (clean.includes("#")) {
    const [agent, session] = clean.split("#");
    const safeAgent = agent.replace(/[^a-zA-Z0-9_-]/g, "") || "default";
    const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, "") || "default";
    return path.join(MESH_DIR, `${safeAgent}-${safeSession}.json`);
  }
  return path.join(MESH_DIR, `${clean}.json`);
}

function readInbox(agentName) {
  const file = getInboxFile(agentName);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function writeInbox(agentName, messages) {
  const target = getInboxFile(agentName);
  const tmp = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(messages, null, 2), "utf8");
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.writeFileSync(target, JSON.stringify(messages, null, 2), "utf8");
    } catch {}
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
  }
}

function checkAndMarkRead(agentName) {
  const inbox = readInbox(agentName);
  const unread = inbox.filter(m => !m.read);
  inbox.forEach(m => (m.read = true));
  writeInbox(agentName, inbox);
  return unread;
}

function listActiveMailboxes() {
  if (!fs.existsSync(MESH_DIR)) return [];
  const files = fs.readdirSync(MESH_DIR);
  const mailboxes = [];
  files.forEach(f => {
    if (f.endsWith(".json")) {
      const name = f.replace(".json", "");
      try {
        const content = JSON.parse(fs.readFileSync(path.join(MESH_DIR, f), "utf8") || "[]");
        const unreadCount = content.filter(m => !m.read).length;
        mailboxes.push({ name, total: content.length, unread: unreadCount });
      } catch {}
    }
  });
  return mailboxes;
}

function clearInbox(agentName) {
  const file = getInboxFile(agentName);
  if (fs.existsSync(file)) {
    fs.writeFileSync(file, "[]", "utf8");
  }
}

function waitForUnread(agentName, timeoutMs = 300000) {
  return new Promise((resolve) => {
    // 1. Check immediately
    const immediate = checkAndMarkRead(agentName);
    if (immediate.length > 0) {
      return resolve(immediate);
    }

    const inboxFile = getInboxFile(agentName);
    let resolved = false;
    let timer = null;
    let pollInterval = null;
    let watcher = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (pollInterval) clearInterval(pollInterval);
      if (watcher) {
        try { watcher.close(); } catch {}
      }
    };

    const checkNow = () => {
      if (resolved) return;
      const inbox = readInbox(agentName);
      const unread = inbox.filter(m => !m.read);
      if (unread.length > 0) {
        resolved = true;
        inbox.forEach(m => (m.read = true));
        writeInbox(agentName, inbox);
        cleanup();
        resolve(unread);
      }
    };

    // Timeout
    timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve([]);
      }
    }, timeoutMs);


    // Poll fallback
    pollInterval = setInterval(checkNow, 500);


    // fs watcher on MESH_DIR
    try {
      watcher = fs.watch(MESH_DIR, (eventType, filename) => {
        if (!filename) {
          checkNow();
          return;
        }
        const targetFilename = path.basename(inboxFile).toLowerCase();
        if (filename.toLowerCase() === targetFilename || filename.toLowerCase().startsWith(agentName.toLowerCase())) {
          checkNow();
        }
      });

    } catch {}
  });
}

const CHANNELS_DIR = path.join(MESH_DIR, "channels");
if (!fs.existsSync(CHANNELS_DIR)) {
  try { fs.mkdirSync(CHANNELS_DIR, { recursive: true }); } catch {}
}

function getChannelFile(channelName) {
  const safeBasename = path.basename(String(channelName).replace(/\\/g, "/"));
  const clean = safeBasename.toLowerCase().replace(/^#/, "").replace(/[^a-zA-Z0-9_-]/g, "") || "general";
  return path.join(CHANNELS_DIR, `${clean}.json`);
}

function readChannel(channelName) {
  const file = getChannelFile(channelName);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function sendChannelMessage(channelName, from, message) {
  const file = getChannelFile(channelName);
  const cleanName = path.basename(file, ".json");
  const messages = readChannel(channelName);
  const msgObj = {
    id: Date.now() + "-" + Math.random().toString(36).substring(2, 6),
    channel: `#${cleanName}`,
    from,
    message,
    timestamp: new Date().toISOString()
  };
  messages.push(msgObj);

  // Atomic write
  const tmp = `${file}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(messages, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    try { fs.writeFileSync(file, JSON.stringify(messages, null, 2), "utf8"); } catch {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }

  return msgObj;
}

function listChannels() {
  if (!fs.existsSync(CHANNELS_DIR)) return [];
  const files = fs.readdirSync(CHANNELS_DIR);
  const channels = [];
  files.forEach(f => {
    if (f.endsWith(".json")) {
      const name = "#" + f.replace(".json", "");
      try {
        const content = JSON.parse(fs.readFileSync(path.join(CHANNELS_DIR, f), "utf8") || "[]");
        channels.push({ name, total: content.length, lastMessage: content[content.length - 1] || null });
      } catch {}
    }
  });
  return channels;
}

function broadcastToAgents(from, targets, message, dispatchFn) {
  let targetList = [];
  if (Array.isArray(targets)) {
    targetList = targets;
  } else if (typeof targets === "string") {
    if (targets.toLowerCase() === "all" || targets === "*") {
      targetList = listActiveMailboxes().map(m => m.name);
    } else {
      targetList = targets.split(",").map(t => t.trim()).filter(Boolean);
    }
  }

  const results = [];
  targetList.forEach(to => {
    if (to.toLowerCase() !== from.toLowerCase()) {
      const res = dispatchFn(from, to, message);
      results.push({ to, status: "dispatched", messageId: res.id });
    }
  });
  return results;
}

module.exports = {
  getInboxFile,
  readInbox,
  writeInbox,
  checkAndMarkRead,
  clearInbox,
  waitForUnread,
  listActiveMailboxes,
  getChannelFile,
  readChannel,
  sendChannelMessage,
  listChannels,
  broadcastToAgents
};
