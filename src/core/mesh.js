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
  fs.writeFileSync(getInboxFile(agentName), JSON.stringify(messages, null, 2), 'utf8');
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

module.exports = {
  getInboxFile,
  readInbox,
  writeInbox,
  checkAndMarkRead,
  listActiveMailboxes
};
