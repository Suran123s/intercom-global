// src/bridges/a2a.js - Agent2Agent (A2A) Protocol Bridge & Agent Card Provider
const { listActiveMailboxes } = require('../core/mesh');
const { getPort } = require('../config');

const MAX_A2A_TASKS = 1000;
const A2A_TASK_TTL_MS = 60 * 60 * 1000; // 1 hour

const tasks = new Map();

function pruneAndStoreTask(taskId, taskRecord) {
  const now = Date.now();
  for (const [id, entry] of tasks.entries()) {
    if (entry.expiresAt <= now) {
      tasks.delete(id);
    }
  }
  if (tasks.has(taskId)) {
    tasks.delete(taskId);
  } else if (tasks.size >= MAX_A2A_TASKS) {
    const oldestKey = tasks.keys().next().value;
    if (oldestKey !== undefined) {
      tasks.delete(oldestKey);
    }
  }
  tasks.set(taskId, {
    task: taskRecord,
    expiresAt: now + A2A_TASK_TTL_MS
  });
}

async function generateAgentCard(host = `http://localhost:${getPort()}`) {
  const mailboxes = await listActiveMailboxes({ excludeEphemeral: true });
  const skills = [
    {
      id: "universal-mesh-relay",
      name: "Cross-IDE & Cross-Agent Mesh Relay",
      description: "Delivers instructions, questions, and tasks directly to AI companion agents running across local IDEs (Cursor, Antigravity, Pi, OpenCode) and cloud instances.",
      tags: ["intercom", "multi-agent", "coordination", "task-delegation"],
      inputModes: ["application/json", "text/plain"],
      outputModes: ["application/json", "text/plain"],
      examples: [
        "Run unit tests across backend modules and report failures",
        "Perform schema review on database models"
      ]
    }
  ];

  mailboxes.forEach(m => {
    skills.push({
      id: `agent-mailbox-${m.name.toLowerCase()}`,
      name: `Companion Agent Mailbox: ${m.name.toUpperCase()}`,
      description: `Targeted task queue for AI companion agent '${m.name}' with ${m.total} total logged messages.`,
      tags: ["companion", m.name.toLowerCase(), "agent-inbox"],
      inputModes: ["application/json", "text/plain"],
      outputModes: ["application/json", "text/plain"]
    });
  });

  return {
    name: "Intercom Global Mesh Coordinator",
    description: "Universal multi-IDE and multi-CLI Agent2Agent (A2A) communication mesh and task coordination broker.",
    version: "1.0.0",
    protocolVersion: "1.0",
    supportedInterfaces: [
      {
        url: `${host}/a2a/v1`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0"
      },
      {
        url: `${host}/a2a/sendMessage`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0"
      }
    ],
    provider: {
      organization: "Intercom Global Open Project",
      url: "https://github.com/Suran123s/intercom-global"
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: true
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: skills
  };
}

function extractA2AText(body) {
  if (typeof body.text === 'string' && body.text.trim()) {
    return body.text;
  }
  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    return body.prompt;
  }
  if (typeof body.message === 'string' && body.message.trim()) {
    return body.message;
  }
  if (body.message && typeof body.message === 'object' && !Array.isArray(body.message)) {
    const msg = body.message;
    if (msg.content && typeof msg.content === 'object' && typeof msg.content.text === 'string' && msg.content.text.trim()) {
      return msg.content.text;
    }
    if (typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content;
    }
    if (typeof msg.text === 'string' && msg.text.trim()) {
      return msg.text;
    }
    if (Array.isArray(msg.parts)) {
      const partTexts = msg.parts
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            if (typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
          }
          return '';
        })
        .filter(Boolean);
      if (partTexts.length > 0) {
        return partTexts.join('\n');
      }
    }
    if (msg.content !== undefined) {
      return JSON.stringify(msg.content);
    }
    if (Object.keys(msg).length > 0) {
      return JSON.stringify(msg);
    }
  }
  return '';
}

function processA2AMessage(payload, dispatchFn) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error("Invalid A2A request payload: payload must be a non-null JSON object");
  }
  if (typeof dispatchFn !== 'function') {
    throw new Error("Invalid A2A dispatch handler");
  }

  // Normalize JSON-RPC params wrapper and flat schemas uniformly
  const body = (payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params))
    ? { ...payload, ...payload.params }
    : payload;

  const rawFrom = body.sender
    ?? body.from
    ?? body.message?.sender
    ?? body.metadata?.sender
    ?? 'a2a-client';
  const from = (typeof rawFrom === 'string' && rawFrom.trim()) ? rawFrom.trim() : 'a2a-client';

  const rawTo = body.recipient
    ?? body.to
    ?? body.target
    ?? body.message?.recipient
    ?? body.metadata?.recipient
    ?? process.env.INTERCOM_DEFAULT_RECIPIENT;
  const to = (typeof rawTo === 'string') ? rawTo.trim() : '';

  if (!to) {
    throw new Error("Invalid A2A request payload: missing target recipient ('recipient' or 'to')");
  }

  const text = extractA2AText(body);
  if (!text || (typeof text === 'string' && !text.trim())) {
    throw new Error("Invalid A2A request payload: missing message text content");
  }

  const taskId = "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const dispatched = dispatchFn(from, to, text);

  const taskRecord = {
    taskId: taskId,
    status: "SUBMITTED",
    createdTime: new Date().toISOString(),
    updatedTime: new Date().toISOString(),
    recipient: to,
    sender: from,
    message: {
      role: "agent",
      content: {
        text: `Delivered to companion '${to}' inbox via Intercom Global mesh. (Message ID: ${dispatched.id})`
      }
    },
    metadata: {
      meshId: dispatched.id,
      timestamp: dispatched.timestamp
    }
  };

  pruneAndStoreTask(taskId, taskRecord);
  return taskRecord;
}

function getA2ATask(taskId) {
  if (!taskId || !tasks.has(taskId)) return null;
  const entry = tasks.get(taskId);
  if (entry.expiresAt <= Date.now()) {
    tasks.delete(taskId);
    return null;
  }
  // Refresh LRU recency
  tasks.delete(taskId);
  tasks.set(taskId, entry);
  return entry.task;
}

module.exports = {
  generateAgentCard,
  processA2AMessage,
  getA2ATask
};
