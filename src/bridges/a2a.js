// src/bridges/a2a.js - Agent2Agent (A2A) Protocol Bridge & Agent Card Provider
const { listActiveMailboxes } = require('../core/mesh');
const { PORT } = require('../config');

const tasks = new Map();

async function generateAgentCard(host = `http://localhost:${PORT}`) {
  const mailboxes = await listActiveMailboxes();
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

function processA2AMessage(payload, dispatchFn) {
  const taskId = "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  let from = "a2a-client";
  let to = "suran";
  let text = "";

  // Support both standard A2A schema and simplified schema
  if (payload.message && typeof payload.message === "object") {
    text = payload.message.content?.text || payload.message.text || JSON.stringify(payload.message.content || payload.message);
    if (payload.recipient) to = payload.recipient;
    if (payload.sender) from = payload.sender;
  } else if (payload.text || payload.prompt) {
    text = payload.text || payload.prompt;
    if (payload.to) to = payload.to;
    if (payload.from) from = payload.from;
  } else if (payload.from && payload.to && payload.message) {
    from = payload.from;
    to = payload.to;
    text = typeof payload.message === "string" ? payload.message : JSON.stringify(payload.message);
  }

  if (!text) {
    throw new Error("Invalid A2A request payload: missing message text content");
  }

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

  tasks.set(taskId, taskRecord);
  return taskRecord;
}

function getA2ATask(taskId) {
  return tasks.get(taskId) || null;
}

module.exports = {
  generateAgentCard,
  processA2AMessage,
  getA2ATask
};
