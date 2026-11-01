// src/core/session-sync.js - Multi-Harness Session Ledger Synchronization
const fs = require('fs');
const path = require('path');
const { MESH_DIR } = require('../config');
const { sanitizeAgentName } = require('./mesh');

const DEFAULT_EXDELEGATE_DIR = process.env.EXDELEGATE_DIR || path.resolve(
  process.env.USERPROFILE || process.env.HOME || '',
  '.mcp-servers',
  'ex-delegate-mcp'
);

class SessionLedgerSync {
  constructor(meshDir = MESH_DIR) {
    this.meshDir = meshDir || MESH_DIR;
    this.sessionsDir = path.join(this.meshDir, 'sessions');
    if (!fs.existsSync(this.sessionsDir)) {
      try { fs.mkdirSync(this.sessionsDir, { recursive: true }); } catch {}
    }
  }

  recordSession(record) {
    if (!record || !record.sessionId) {
      throw new Error('sessionId is required for session ledger');
    }

    const safeId = sanitizeAgentName(String(record.sessionId));
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);
    let toSave = {
      ...record,
      sessionId: safeId,
      updatedAt: record.updatedAt || new Date().toISOString()
    };

    if (fs.existsSync(filePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
        const newTime = new Date(toSave.updatedAt).getTime();
        // Conflict resolution: newest timestamp wins
        if (existingTime > newTime) {
          return existing;
        }
        toSave = { ...existing, ...toSave };
      } catch {}
    }

    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf8');
    return toSave;
  }

  getSession(sessionId) {
    const safeId = sanitizeAgentName(String(sessionId));
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  listSessions(filter = {}) {
    if (!fs.existsSync(this.sessionsDir)) return [];
    const files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp'));
    const sessions = [];

    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf8'));
        if (filter.harness && s.harness !== filter.harness) continue;
        if (filter.status && s.status !== filter.status) continue;
        if (filter.agent && s.agent !== filter.agent) continue;
        sessions.push(s);
      } catch {}
    }

    // Sort newest updated first
    sessions.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    return sessions;
  }
}

async function syncFromExdelegate(exdelegateDir = DEFAULT_EXDELEGATE_DIR, meshDir = MESH_DIR) {
  const ledger = new SessionLedgerSync(meshDir);
  const report = { synced: 0, updated: 0, activeSessions: [] };

  if (!fs.existsSync(exdelegateDir)) {
    return report;
  }

  const sessionsDir = path.join(exdelegateDir, 'sessions');
  const indexFile = path.join(exdelegateDir, 'sessions-index.json');
  const discovered = new Map();

  if (fs.existsSync(indexFile)) {
    try {
      const content = fs.readFileSync(indexFile, 'utf8');
      const parsed = JSON.parse(content);
      const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
      for (const s of list) {
        if (s && (s.sessionId || s.id)) {
          discovered.set(s.sessionId || s.id, s);
        }
      }
    } catch {}
  }

  if (fs.existsSync(sessionsDir)) {
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = fs.readFileSync(path.join(sessionsDir, f), 'utf8');
          const s = JSON.parse(raw);
          const id = s.sessionId || s.id || f.replace('.json', '');
          if (!discovered.has(id)) {
            discovered.set(id, s);
          }
        } catch {}
      }
    } catch {}
  }

  for (const [id, session] of discovered.entries()) {
    const exists = ledger.getSession(id);
    const saved = ledger.recordSession({
      sessionId: id,
      name: session.name || session.session_name || null,
      source: 'ex-delegate',
      harness: session.harness || 'auto',
      model: session.model || null,
      agent: session.agent || 'general',
      status: session.status || 'active',
      pid: session.pid || null,
      workingDirectory: session.working_directory || session.workingDirectory || null,
      createdAt: session.createdAt || session.startTime || new Date().toISOString(),
      updatedAt: session.updatedAt || session.endTime || new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      taskIds: session.taskIds || (session.taskId ? [session.taskId] : []),
      metadata: session.metadata || {}
    });

    if (exists) report.updated++;
    else report.synced++;

    report.activeSessions.push(saved);
  }

  return report;
}

function listSynchronizedSessions(meshDir = MESH_DIR) {
  const ledger = new SessionLedgerSync(meshDir);
  return ledger.listSessions();
}

module.exports = {
  SessionLedgerSync,
  syncFromExdelegate,
  listSynchronizedSessions,
  DEFAULT_EXDELEGATE_DIR
};
