// src/mcp/server.js - Model Context Protocol (MCP) Stdio Server for Intercom Tools
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const { MessageEnvelope } = require('../core/message');
const {
  writeMessage,
  readInbox,
  ackMessage,
  listActiveMailboxes,
  waitForUnread,
  validateAgentName
} = require('../core/mesh');
const {
  registerAgent,
  getAgentState,
  listActiveAgents,
  touchHeartbeat
} = require('../core/registry');
const { interruptAgent } = require('../core/interrupter');
const { PORT } = require('../config');

const MCP_TOOLS = [
    {
      name: "send_message",
      description: "Dispatch a message or task to another AI companion or supervisor across IDEs and terminal harnesses",
      inputSchema: {
        type: "object",
        properties: {
          sender: { type: "string", description: "Sending agent or user identifier" },
          recipient: { type: "string", description: "Target receiving agent identifier" },
          message: { type: "string", description: "Task description, instruction, or data payload" },
          type: {
            type: "string",
            enum: ["task_dispatch", "task_response", "interrupt", "heartbeat", "ack"],
            description: "Semantic message type (default: task_dispatch)"
          },
          priority: {
            type: "string",
            enum: ["LOW", "NORMAL", "HIGH", "CRITICAL"],
            description: "Message priority (default: NORMAL)"
          },
          correlationId: { type: "string", description: "Correlation UUID linking task to response" },
          parentId: { type: "string", description: "Supervisor session UUID" }
        },
        required: ["sender", "recipient", "message"]
      }
    },
    {
      name: "receive_messages",
      description: "Read incoming discrete messages from this agent's inbox",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Your agent identifier" },
          limit: { type: "number", description: "Maximum messages to return (default: 50)" },
          ack: { type: "boolean", description: "Automatically acknowledge and archive read messages (default: false)" }
        },
        required: ["agent"]
      }
    },
    {
      name: "interrupt_agent",
      description: "Issue a 3-tier real-time interruption to halt or redirect an agent workflow",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Target agent to interrupt" },
          reason: { type: "string", description: "Reason for interruption or new steering instruction" },
          mode: {
            type: "string",
            enum: ["auto", "pty", "jsonrpc", "mesh"],
            description: "Interruption mode (default: auto)"
          }
        },
        required: ["target", "reason"]
      }
    },
    {
      name: "get_agent_status",
      description: "Retrieve an agent's registered state card, IDE, role, PID, and capabilities",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent identifier" }
        },
        required: ["agent"]
      }
    },
    {
      name: "list_agents",
      description: "Discover all active registered agents and mailbox queues",
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string", description: "Filter by agent role (worker, reviewer, auditor, etc.)" },
          ide: { type: "string", description: "Filter by IDE environment" }
        }
      }
    },
    // Backwards Compatibility Aliases
    {
      name: "intercom_send",
      description: "Send a message or delegate a task (legacy alias)",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          message: { type: "string" }
        },
        required: ["from", "to", "message"]
      }
    },
    {
      name: "intercom_wake",
      description: "Wake a target agent (legacy alias)",
      inputSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string" },
          reason: { type: "string" }
        },
        required: ["targetAgent"]
      }
    },
    {
      name: "intercom_watch",
      description: "Wait reactively for incoming unread messages",
      inputSchema: {
        type: "object",
        properties: {
          forAgent: { type: "string" },
          timeoutSeconds: { type: "number" }
        },
        required: ["forAgent"]
      }
    },
    {
      name: "intercom_read",
      description: "Read messages from agent inbox (legacy alias)",
      inputSchema: {
        type: "object",
        properties: {
          forAgent: { type: "string" }
        },
        required: ["forAgent"]
      }
    },
    {
      name: "intercom_clear",
      description: "Clear agent inbox (legacy alias)",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" }
        },
        required: ["agent"]
      }
    },
    {
      name: "intercom_list_peers",
      description: "List all known peers (legacy alias)",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
];

function startMcpServer() {
  // CRITICAL INVARIANT: Isolate stdout strictly for MCP JSON-RPC protocol
  const originalLog = console.log;
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);

  const server = new Server(
    { name: "intercom-global", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "send_message" || name === "intercom_send") {
        const sender = args.sender || args.from;
        const recipient = args.recipient || args.to;
        const message = args.message;
        const type = args.type || 'task_dispatch';
        const priority = args.priority || 'NORMAL';
        const correlationId = args.correlationId;
        const parentId = args.parentId;

        const envelope = MessageEnvelope.create({
          sender,
          recipient,
          type,
          priority,
          payload: { message },
          correlationId,
          parentId
        });

        // Fast-Path attempt via daemon
        let deliveredFastPath = false;
        try {
          const res = await fetch(`http://127.0.0.1:${PORT || 4150}/api/intercom/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope.toJSON())
          });
          if (res.ok) {
            const data = await res.json();
            deliveredFastPath = true;
            if (name === "intercom_send") {
              return {
                content: [{
                  type: "text",
                  text: `Delivered message to ${recipient} (ID: ${envelope.id})`
                }]
              };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: data.status,
                  messageId: envelope.id,
                  envelope: envelope.toJSON()
                }, null, 2)
              }]
            };
          }
        } catch {}

        // Safe-Path fallback
        const result = await writeMessage(recipient, envelope);
        if (name === "intercom_send") {
          return {
            content: [{
              type: "text",
              text: `Delivered message to ${recipient} (ID: ${envelope.id})`
            }]
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "DELIVERED_SAFE_PATH",
              messageId: envelope.id,
              path: result.path,
              envelope: envelope.toJSON()
            }, null, 2)
          }]
        };
      }

      if (name === "receive_messages") {
        const agent = args.agent;
        const limit = args.limit || 50;
        const shouldAck = args.ack === true;

        const envelopes = await readInbox(agent);
        const sliced = envelopes.slice(0, limit);

        if (shouldAck) {
          for (const env of sliced) {
            await ackMessage(agent, env.id);
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: sliced.length,
              messages: sliced.map(e => (e.toJSON ? e.toJSON() : e))
            }, null, 2)
          }]
        };
      }

      if (name === "interrupt_agent") {
        const target = args.target;
        const reason = args.reason;
        const mode = args.mode || 'auto';

        const result = await interruptAgent(target, reason, { mode });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      }

      if (name === "get_agent_status") {
        const agent = args.agent;
        const card = await getAgentState(agent);
        if (!card) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: `Agent "${agent}" is not registered in registry` }, null, 2)
            }]
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify(card, null, 2)
          }]
        };
      }

      if (name === "list_agents") {
        const active = await listActiveAgents();
        const mailboxes = await listActiveMailboxes({ excludeEphemeral: args.include_ephemeral !== true });

        let filtered = active;
        if (args.role) filtered = filtered.filter(a => a.role === args.role);
        if (args.ide) filtered = filtered.filter(a => a.ide === args.ide);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              activeAgents: filtered,
              mailboxes
            }, null, 2)
          }]
        };
      }

      if (name === "intercom_watch") {
        const forAgent = args.forAgent;
        const timeoutMs = (args.timeoutSeconds || 30) * 1000;
        const msgs = await waitForUnread(forAgent, timeoutMs);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(msgs.map(m => m.toJSON ? m.toJSON() : m), null, 2)
          }]
        };
      }

      if (name === "intercom_wake") {
        const target = args.targetAgent || args.target;
        const reason = args.reason || "Wake requested";
        const result = await interruptAgent(target, reason, { mode: 'mesh' });
        return {
          content: [{
            type: "text",
            text: `Woke agent ${target} via ${result.method}`
          }]
        };
      }

      if (name === "intercom_read") {
        const forAgent = args.forAgent || args.agent;
        const envelopes = await readInbox(forAgent);
        const formatted = envelopes.map(e => {
          const raw = e.toJSON ? e.toJSON() : e;
          return {
            ...raw,
            message: (raw.payload && raw.payload.message) || raw.message || ''
          };
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(formatted, null, 2)
          }]
        };
      }

      if (name === "intercom_clear") {
        const agent = args.agent || args.forAgent;
        const { clearInbox } = require('../core/mesh');
        const count = await clearInbox(agent);
        return {
          content: [{
            type: "text",
            text: `Cleared inbox: ${count} messages removed for "${agent}".`
          }]
        };
      }

      if (name === "intercom_list_peers") {
        const active = await listActiveAgents();
        const mailboxes = await listActiveMailboxes({ excludeEphemeral: args.include_ephemeral !== true });
        const allPeers = Array.from(new Set([
          ...active.map(a => a.name),
          ...mailboxes.map(m => m.name)
        ]));
        return {
          content: [{
            type: "text",
            text: JSON.stringify(allPeers)
          }]
        };
      }

      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error executing ${name}: ${err.message}` }]
      };
    }
  });

  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Fatal MCP Server Error:", err);
  });
}

module.exports = {
  startMcpServer,
  MCP_TOOLS
};

if (require.main === module) {
  startMcpServer();
}
