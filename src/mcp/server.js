// src/mcp/server.js - Stdio MCP Server for Intercom Tools
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { readInbox, writeInbox, checkAndMarkRead, clearInbox, waitForUnread, listActiveMailboxes } = require("../core/mesh");
const { wakeAgent } = require("../controllers/autowake");

function startMcpServer() {
  // Isolate stdout for MCP JSON-RPC protocol exclusively
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);

  const server = new Server(
    { name: "intercom-global", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "intercom_send",
        description: "Send a message or delegate a task to another AI companion in another IDE, terminal, or cloud session",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Your identity or session name" },
            to: { type: "string", description: "Recipient companion name (e.g. madhav, keshav, suraj, pal, devin, cursor)" },
            message: { type: "string", description: "Task instructions, questions, or findings" }
          },
          required: ["from", "to", "message"]
        }
      },
      {
        name: "intercom_wake",
        description: "Interrupt and auto-wake a specific companion AI session, triggering an immediate execution turn",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Target companion name" },
            message: { type: "string", description: "Immediate task to execute upon waking" }
          },
          required: ["to", "message"]
        }
      },
      {
        name: "intercom_watch",
        description: "Wait reactively for incoming unread messages or delegated tasks (zero CPU polling)",
        inputSchema: {
          type: "object",
          properties: {
            forAgent: { type: "string", description: "Your companion name" },
            timeoutSeconds: { type: "number", description: "Maximum seconds to wait (default: 300)" }
          },
          required: ["forAgent"]
        }
      },
      {
        name: "intercom_read",
        description: "Check for unread messages sent to you from companion AIs",
        inputSchema: {
          type: "object",
          properties: {
            forAgent: { type: "string", description: "Your companion name" }
          },
          required: ["forAgent"]
        }
      },
      {
        name: "intercom_clear",
        description: "Clear/empty an agent's inbox after completing processing",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Agent name to clear inbox for" }
          },
          required: ["agent"]
        }
      },
      {
        name: "intercom_list_peers",
        description: "List all active mailboxes and companions currently registered on this machine",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "intercom_send") {
        if (!args.from || !args.to || !args.message) {
          return { content: [{ type: "text", text: "Missing required fields: from, to, message" }], isError: true };
        }
        const inbox = readInbox(args.to);
        const msgObj = {
          id: Date.now(),
          from: args.from,
          to: args.to,
          message: args.message,
          timestamp: new Date().toISOString(),
          read: false
        };
        inbox.push(msgObj);
        writeInbox(args.to, inbox);
        return { content: [{ type: "text", text: `[Intercom] Delivered message from ${args.from} to ${args.to}` }] };
      }

      if (name === "intercom_wake") {
        if (!args.to || !args.message) {
          return { content: [{ type: "text", text: "Missing required fields: to, message" }], isError: true };
        }
        wakeAgent(args.to, args.message);
        return { content: [{ type: "text", text: `[Intercom] Sent interrupting auto-wake signal to ${args.to}` }] };
      }

      if (name === "intercom_watch") {
        if (!args.forAgent) {
          return { content: [{ type: "text", text: "Missing required field: forAgent" }], isError: true };
        }
        const timeoutMs = (args.timeoutSeconds ? Math.max(1, Number(args.timeoutSeconds)) : 300) * 1000;
        const unread = await waitForUnread(args.forAgent, timeoutMs);
        return {
          content: [{
            type: "text",
            text: unread.length ? JSON.stringify(unread, null, 2) : "No new messages received within timeout window."
          }]
        };
      }

      if (name === "intercom_read") {
        if (!args.forAgent) {
          return { content: [{ type: "text", text: "Missing required field: forAgent" }], isError: true };
        }
        const unread = checkAndMarkRead(args.forAgent);
        return {
          content: [{
            type: "text",
            text: unread.length ? JSON.stringify(unread, null, 2) : "No new unread messages in inbox."
          }]
        };
      }

      if (name === "intercom_clear") {
        if (!args.agent) {
          return { content: [{ type: "text", text: "Missing required field: agent" }], isError: true };
        }
        clearInbox(args.agent);
        return { content: [{ type: "text", text: `[Intercom] Cleared inbox for agent ${args.agent}` }] };
      }

      if (name === "intercom_list_peers") {
        const peers = listActiveMailboxes();
        return { content: [{ type: "text", text: JSON.stringify(peers, null, 2) }] };
      }

      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    } catch (err) {
      return { content: [{ type: "text", text: `Error executing ${name}: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  server.connect(transport);

  process.on("SIGINT", () => {
    try { server.close(); } catch {}
  });
  process.on("SIGTERM", () => {
    try { server.close(); } catch {}
  });
}

module.exports = { startMcpServer };

if (require.main === module) {
  startMcpServer();
}

