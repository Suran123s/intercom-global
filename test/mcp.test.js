// test/mcp.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { getInboxFile } = require('../src/core/mesh');

test('MCP server lists tools and handles tool calls', async () => {
  const serverPath = path.resolve(__dirname, '..', 'bin', 'intercom-mcp.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath]
  });

  const client = new Client(
    { name: 'mcp-test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  // 1. List tools
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map(t => t.name);
  assert.ok(toolNames.includes('intercom_send'));
  assert.ok(toolNames.includes('intercom_wake'));
  assert.ok(toolNames.includes('intercom_watch'));
  assert.ok(toolNames.includes('intercom_read'));
  assert.ok(toolNames.includes('intercom_clear'));
  assert.ok(toolNames.includes('intercom_list_peers'));

  const testAgent = 'mcp-agent-' + Date.now();
  const file = getInboxFile(testAgent);

  // 2. Call intercom_send
  const sendRes = await client.callTool({
    name: 'intercom_send',
    arguments: {
      from: 'mcp-tester',
      to: testAgent,
      message: 'Hello via MCP!'
    }
  });
  assert.strictEqual(sendRes.isError, undefined);
  assert.match(sendRes.content[0].text, /Delivered message/);

  // 3. Call intercom_read
  const readRes = await client.callTool({
    name: 'intercom_read',
    arguments: {
      forAgent: testAgent
    }
  });
  assert.match(readRes.content[0].text, /Hello via MCP!/);

  // 4. Call intercom_clear
  const clearRes = await client.callTool({
    name: 'intercom_clear',
    arguments: {
      agent: testAgent
    }
  });
  assert.match(clearRes.content[0].text, /Cleared inbox/);

  // 5. Call intercom_list_peers
  const peersRes = await client.callTool({
    name: 'intercom_list_peers',
    arguments: {}
  });
  assert.ok(Array.isArray(JSON.parse(peersRes.content[0].text)));

  // Cleanup
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }

  await client.close();
});
