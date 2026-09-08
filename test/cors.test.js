const test = require("node:test");
const assert = require("node:assert");
const { createServer } = require("../src/core/server");

test("CORS headers default behavior for local and external origins", async () => {
  const server = createServer();
  const testPort = 4280;
  await new Promise((resolve) => server.listen(testPort, resolve));

  try {
    // 1. Request with local origin (http://localhost:3000)
    const localRes = await fetch(`http://localhost:${testPort}/.well-known/agent.json`, {
      headers: { Origin: "http://localhost:3000" }
    });
    assert.strictEqual(localRes.headers.get("access-control-allow-origin"), "http://localhost:3000");

    // 2. Request with 127.0.0.1 origin
    const ipRes = await fetch(`http://localhost:${testPort}/.well-known/agent.json`, {
      headers: { Origin: "http://127.0.0.1:8080" }
    });
    assert.strictEqual(ipRes.headers.get("access-control-allow-origin"), "http://127.0.0.1:8080");

    // 3. Request with file:// origin ("null")
    const nullRes = await fetch(`http://localhost:${testPort}/.well-known/agent.json`, {
      headers: { Origin: "null" }
    });
    assert.strictEqual(nullRes.headers.get("access-control-allow-origin"), "null");

    // 4. Request with untrusted origin (http://evil.com) - should not set Access-Control-Allow-Origin
    const untrustedRes = await fetch(`http://localhost:${testPort}/.well-known/agent.json`, {
      headers: { Origin: "http://evil.com" }
    });
    assert.strictEqual(untrustedRes.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
  }
});

test("CORS headers configurable via ALLOWED_ORIGINS env var", async () => {
  const origEnv = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = "https://app.example.com, https://trusted.org";

  const server = createServer();
  const testPort = 4281;
  await new Promise((resolve) => server.listen(testPort, resolve));

  try {
    // Allowed origin 1
    const res1 = await fetch(`http://localhost:${testPort}/.well-known/agent.json`, {
      headers: { Origin: "https://app.example.com" }
    });
    assert.strictEqual(res1.headers.get("access-control-allow-origin"), "https://app.example.com");

    // Allowed origin 2
    const res2 = await fetch(`http://localhost:${testPort}/.well-known/agent.json`, {
      headers: { Origin: "https://trusted.org" }
    });
    assert.strictEqual(res2.headers.get("access-control-allow-origin"), "https://trusted.org");

    // Disallowed origin when ALLOWED_ORIGINS is set
    const res3 = await fetch(`http://localhost:${testPort}/.well-known/agent.json`, {
      headers: { Origin: "http://localhost:3000" }
    });
    assert.strictEqual(res3.headers.get("access-control-allow-origin"), null);
  } finally {
    if (origEnv !== undefined) process.env.ALLOWED_ORIGINS = origEnv;
    else delete process.env.ALLOWED_ORIGINS;
    server.close();
  }
});

test("CORS headers wildcard allow via ALLOWED_ORIGINS=*", async () => {
  const origEnv = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = "*";

  const server = createServer();
  const testPort = 4282;
  await new Promise((resolve) => server.listen(testPort, resolve));

  try {
    const res = await fetch(`http://localhost:${testPort}/.well-known/agent.json`, {
      headers: { Origin: "https://anywhere.com" }
    });
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    if (origEnv !== undefined) process.env.ALLOWED_ORIGINS = origEnv;
    else delete process.env.ALLOWED_ORIGINS;
    server.close();
  }
});
