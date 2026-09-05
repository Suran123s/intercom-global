// src/mcp/server.js - Stdio MCP Server for Intercom Tools
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { readInbox, writeInbox, checkAndMarkRead, clearInbox, waitForUnread, listActiveMailboxes, sendChannelMessage, readChannel, listChannels, broadcastToAgents } = require("../core/mesh");
const { updateMessageStatus, getDlq } = require("../core/dlq");
const { spawnAgent } = require("../controllers/spawner");
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
        name: "intercom_broadcast",
        description: "Broadcast a task or update to multiple companion agents concurrently (e.g. 'all' or 'pal,keshav,madhav')",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Your identity or session name" },
            to: { type: "string", description: "Target agents (e.g. 'all', or comma-separated 'pal,keshav,madhav')" },
            message: { type: "string", description: "Broadcast announcement or synchronized task" }
          },
          required: ["from", "to", "message"]
        }
      },
      {
        name: "intercom_channel_send",
        description: "Publish a message to a shared multi-agent topic/channel (e.g. '#general', '#backend', '#qa')",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel name (e.g. '#backend' or 'backend')" },
            from: { type: "string", description: "Your identity or session name" },
            message: { type: "string", description: "Message content" }
          },
          required: ["channel", "from", "message"]
        }
      },
      {
        name: "intercom_channel_read",
        description: "Read recent messages posted in a multi-agent topic/channel",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel name (e.g. '#backend' or 'backend')" }
          },
          required: ["channel"]
        }
      },
      {
        name: "intercom_channel_list",
        description: "List all active topic channels and their message counts",
        inputSchema: {
          type: "object",
          properties: {}
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
      },
      {
        name: "intercom_spawn",
        description: "Auto-spawn an agent process on-demand (e.g. 'opencode', 'hermes', 'pi')",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Agent profile name (e.g. opencode, hermes, pi)" },
            visible: { type: "boolean", description: "Show terminal window (default: false)" }
          },
          required: ["agent"]
        }
      },
      {
        name: "intercom_ack",
        description: "Acknowledge task completion, updating status and returning execution result back to the mesh",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Your agent name" },
            messageId: { type: "string", description: "The message/task ID to acknowledge" },
            status: { type: "string", enum: ["COMPLETED", "PROCESSING", "FAILED"], description: "Task status" },
            result: { type: "string", description: "Optional execution result summary or payload" }
          },
          required: ["agent", "messageId"]
        }
      },
      {
        name: "intercom_dlq_list",
        description: "List failed or unacknowledged messages stored in the Dead Letter Queue",
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

      if (name === "intercom_broadcast") {
        if (!args.from || !args.to || !args.message) {
          return { content: [{ type: "text", text: "Missing required fields: from, to, message" }], isError: true };
        }
        const results = broadcastToAgents(args.from, args.to, args.message, (f, t, m) => {
          const inbox = readInbox(t);
          const msgObj = { id: Date.now(), from: f, to: t, message: m, timestamp: new Date().toISOString(), read: false };
          inbox.push(msgObj);
          writeInbox(t, inbox);
          return msgObj;
        });
        return { content: [{ type: "text", text: `[Intercom Broadcast] Dispatched to ${results.length} agents: ${results.map(r => r.to).join(', ')}` }] };
      }

      if (name === "intercom_channel_send") {
        if (!args.channel || !args.from || !args.message) {
          return { content: [{ type: "text", text: "Missing required fields: channel, from, message" }], isError: true };
        }
        const msg = sendChannelMessage(args.channel, args.from, args.message);
        return { content: [{ type: "text", text: `[Intercom Channel] Posted to ${msg.channel} (ID: ${msg.id})` }] };
      }

      if (name === "intercom_channel_read") {
        if (!args.channel) {
          return { content: [{ type: "text", text: "Missing required field: channel" }], isError: true };
        }
        const msgs = readChannel(args.channel);
        return { content: [{ type: "text", text: msgs.length ? JSON.stringify(msgs, null, 2) : `No messages in channel ${args.channel}` }] };
      }

      if (name === "intercom_channel_list") {
        const channels = listChannels();
        return { content: [{ type: "text", text: JSON.stringify(channels, null, 2) }] };
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
        const peers = await listActiveMailboxes();
        return { content: [{ type: "text", text: JSON.stringify(peers, null, 2) }] };
      }

      if (name === "intercom_spawn") {
        if (!args.agent) {
          return { content: [{ type: "text", text: "Missing required field: agent" }], isError: true };
        }
        const result = await spawnAgent(args.agent, { visible: args.visible });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "intercom_ack") {
        if (!args.agent || !args.messageId) {
          return { content: [{ type: "text", text: "Missing required fields: agent, messageId" }], isError: true };
        }
        const updated = updateMessageStatus(args.agent, args.messageId, args.status || "COMPLETED", args.result);
        if (!updated) {
          return { content: [{ type: "text", text: `Message #${args.messageId} not found for agent ${args.agent}` }], isError: true };
        }
        return { content: [{ type: "text", text: `[Intercom ACK] Task #${args.messageId} marked as ${args.status || "COMPLETED"}` }] };
      }

      if (name === "intercom_dlq_list") {
        const dlq = getDlq();
        return { content: [{ type: "text", text: JSON.stringify(dlq, null, 2) }] };
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

