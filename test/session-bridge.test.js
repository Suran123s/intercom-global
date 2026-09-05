const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { sanitizeName } = require("../src/bridges/session-bridge");
const { getInboxFile, getChannelFile } = require("../src/core/mesh");
const { MESH_DIR } = require("../src/config");

test("session-bridge sanitizeName cleans input and prevents path traversal", () => {
  // Safe inputs
  assert.strictEqual(sanitizeName("cli-agent"), "cli-agent");
  assert.strictEqual(sanitizeName("Agent_123"), "agent_123");

  // Relative path traversal attempts
  assert.strictEqual(sanitizeName("../../etc/passwd"), "passwd");
  assert.strictEqual(sanitizeName("../foo/bar"), "bar");
  assert.strictEqual(sanitizeName("..\\..\\windows\\system32"), "system32");

  // Pure traversal sequences fall back to default
  assert.strictEqual(sanitizeName("../../", "fallback"), "fallback");
  assert.strictEqual(sanitizeName("..", "fallback"), "fallback");
  assert.strictEqual(sanitizeName("/", "fallback"), "fallback");

  // Special characters removed
  assert.strictEqual(sanitizeName("agent;rm -rf /"), "agentrm-rf");
});

test("mesh getInboxFile and getChannelFile prevent path traversal", () => {
  const resolvedMesh = path.resolve(MESH_DIR);

  const maliciousAgent = "../../etc/passwd";
  const inboxFile = getInboxFile(maliciousAgent);
  assert.ok(path.resolve(inboxFile).startsWith(resolvedMesh), "inboxFile must remain within MESH_DIR");
  assert.strictEqual(path.basename(inboxFile), "passwd.json");

  const maliciousChannel = "../../../etc/shadow";
  const channelFile = getChannelFile(maliciousChannel);
  assert.ok(path.resolve(channelFile).startsWith(resolvedMesh), "channelFile must remain within MESH_DIR");
  assert.strictEqual(path.basename(channelFile), "shadow.json");
});
