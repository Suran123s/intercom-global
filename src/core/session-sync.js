// src/core/session-sync.js - Multi-Harness Session Ledger Synchronization
const fs = require('fs');
const path = require('path');
const { getMeshDir } = require('../config');
const { sanitizeAgentName, resolveSafePath, withLockSync, atomicWriteFileSync } = require('./mesh');

const DEFAULT_EXDELEGATE_DIR = process.env.EXDELEGATE_DIR || path.resolve(
  process.env.USERPROFILE || process.env.HOME || '',
  '.mcp-servers',
  'ex-delegate-mcp'
);

class SessionLedgerSync {
  constructor(meshDir = getMeshDir()) {
    this.meshDir = meshDir || getMeshDir();
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
    const filePath = resolveSafePath(this.sessionsDir, `${safeId}.json`);
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    return withLockSync(`session_${safeId}`, () => {
      let toSave = {
        ...record,
        sessionId: safeId,
        updatedAt: record.updatedAt || new Date().toISOString()
      };

      const newTime = new Date(toSave.updatedAt).getTime();

      if (fs.existsSync(filePath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (Number.isNaN(newTime)) {
            return existing;
          }
          const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
          // Conflict resolution: newest timestamp wins
          if (!Number.isNaN(existingTime) && existingTime > newTime) {
            return existing;
          }
          toSave = { ...existing, ...toSave };
        } catch {}
      } else if (Number.isNaN(newTime)) {
        toSave.updatedAt = new Date().toISOString();
      }

      atomicWriteFileSync(filePath, JSON.stringify(toSave, null, 2));
      return toSave;
    }, { meshDir: this.meshDir });
  }

  getSession(sessionId) {
    const safeId = sanitizeAgentName(String(sessionId));
    const filePath = resolveSafePath(this.sessionsDir, `${safeId}.json`);
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

async function syncFromExdelegate(exdelegateDir = DEFAULT_EXDELEGATE_DIR, meshDir = getMeshDir()) {
  const ledger = new SessionLedgerSync(meshDir);
  const report = { synced: 0, updated: 0, activeSessions: [] };

  try {
    await fs.promises.access(exdelegateDir);
  } catch {
    return report;
  }

  const sessionsDir = path.join(exdelegateDir, 'sessions');
  const indexFile = path.join(exdelegateDir, 'sessions-index.json');
  const discovered = new Map();

  try {
    const content = await fs.promises.readFile(indexFile, 'utf8');
    const parsed = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    for (const s of list) {
      if (s && (s.sessionId || s.id)) {
        discovered.set(s.sessionId || s.id, s);
      }
    }
  } catch {}

  try {
    const files = await fs.promises.readdir(sessionsDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const BATCH_SIZE = 32;
    for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
      const batch = jsonFiles.slice(i, i + BATCH_SIZE);
      const parsedBatch = await Promise.all(
        batch.map(async (f) => {
          try {
            const raw = await fs.promises.readFile(path.join(sessionsDir, f), 'utf8');
            const s = JSON.parse(raw);
            return { f, s };
          } catch {
            return null;
          }
        })
      );
      for (const item of parsedBatch) {
        if (!item || !item.s) continue;
        const id = item.s.sessionId || item.s.id || item.f.replace('.json', '');
        if (!discovered.has(id)) {
          discovered.set(id, item.s);
        }
      }
    }
  } catch {}

  for (const [id, session] of discovered.entries()) {
    const safeId = sanitizeAgentName(String(id));
    const targetPath = resolveSafePath(ledger.sessionsDir, `${safeId}.json`);
    let existed = false;
    try {
      await fs.promises.access(targetPath);
      existed = true;
    } catch {}

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

    if (existed) report.updated++;
    else report.synced++;

    report.activeSessions.push(saved);
  }

  return report;
}

function listSynchronizedSessions(meshDir = getMeshDir()) {
  const ledger = new SessionLedgerSync(meshDir);
  return ledger.listSessions();
}

module.exports = {
  SessionLedgerSync,
  syncFromExdelegate,
  listSynchronizedSessions,
  DEFAULT_EXDELEGATE_DIR
};
