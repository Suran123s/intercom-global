// src/mcp/server.js - Stdio MCP Server for Intercom Tools
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { readInbox, writeInbox, checkAndMarkRead, listActiveMailboxes } = require("../core/mesh");
const { wakeAgent } = require("../controllers/autowake");

function startMcpServer() {
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

    if (name === "intercom_send") {
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
      wakeAgent(args.to, args.message);
      return { content: [{ type: "text", text: `[Intercom] Sent interrupting auto-wake signal to ${args.to}` }] };
    }

    if (name === "intercom_read") {
      const unread = checkAndMarkRead(args.forAgent);
      return {
        content: [{
          type: "text",
          text: unread.length ? JSON.stringify(unread, null, 2) : "No new unread messages in inbox."
        }]
      };
    }

    if (name === "intercom_list_peers") {
      const peers = listActiveMailboxes();
      return { content: [{ type: "text", text: JSON.stringify(peers, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  server.connect(transport);
}

module.exports = { startMcpServer };

if (require.main === module) {
  startMcpServer();
}
