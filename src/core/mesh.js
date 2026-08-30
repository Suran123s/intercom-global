// src/core/mesh.js - Durable File Mesh Mailbox Operations
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../config');

function getInboxFile(agentName) {
  const clean = agentName.toLowerCase().trim();
  if (clean.includes('#')) {
    const [agent, session] = clean.split('#');
    return path.join(MESH_DIR, `${agent}-${session}.json`);
  }
  return path.join(MESH_DIR, `${clean}.json`);
}

function readInbox(agentName) {
  const file = getInboxFile(agentName);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function writeInbox(agentName, messages) {
  const target = getInboxFile(agentName);
  const tmp = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(messages, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.writeFileSync(target, JSON.stringify(messages, null, 2), 'utf8');
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
    if (f.endsWith('.json')) {
      const name = f.replace('.json', '');
      try {
        const content = JSON.parse(fs.readFileSync(path.join(MESH_DIR, f), 'utf8') || '[]');
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
    fs.writeFileSync(file, '[]', 'utf8');
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
      const unread = checkAndMarkRead(agentName);
      if (unread.length > 0) {
        resolved = true;
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

module.exports = {
  getInboxFile,
  readInbox,
  writeInbox,
  checkAndMarkRead,
  clearInbox,
  waitForUnread,
  listActiveMailboxes
};

