import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMockJira } from "./fixtures/mock-jira.js";
import { createSettingsHome } from "./fixtures/settings.js";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const credentials = { JIRA_COOKIE_NAME: "JSESSIONID", JIRA_COOKIE_VALUE: "cli-test-session" };

function environment(home: string, certificate?: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home,
    ...(certificate ? { NODE_EXTRA_CA_CERTS: certificate } : {}),
  };
}

test("compiled CLI handles MCP calls against HTTPS Jira with trusted test CA", { timeout: 10_000 }, async (t) => {
  const jira = await createMockJira();
  t.after(jira.close);
  const home = await createSettingsHome(t, { JIRA_URL: jira.url, ...credentials });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], stderr: "pipe",
    env: { ...environment(home, jira.certificate), JIRA_COOKIE_VALUE: "ignored-env-cookie" },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "cli-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 9);
  const result = await client.callTool({ name: "get_projects", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify([{ key: "TEST", name: "Mock Jira" }]) }]);
  assert.equal(jira.requests.length, 1);
  assert.equal(jira.requests[0]?.path, "/jira/rest/api/2/project");
  assert.equal(jira.requests[0]?.cookie, `${credentials.JIRA_COOKIE_NAME}=${credentials.JIRA_COOKIE_VALUE}`);
  assert.equal(stderr, "");
});

test("CLI refuses invalid settings before opening stdio, without exposing credentials", async (t) => {
  const home = await createSettingsHome(t, { JIRA_URL: "http://embedded-user:embedded-secret@jira.example.com", ...credentials });
  const child = spawnSync(process.execPath, [entry], {
    env: environment(home), encoding: "utf8", timeout: 3000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /JIRA_URL/);
  for (const value of [credentials.JIRA_COOKIE_VALUE, "embedded-secret"]) {
    assert.ok(!child.stderr.includes(value));
  }
});

for (const termination of ["stdin", "SIGINT", "SIGTERM"] as const) {
  test(`CLI ${termination} aborts an active Jira request and exits cleanly`, { timeout: 10_000 }, async (t) => {
    const jira = await createMockJira(true);
    t.after(jira.close);
    const home = await createSettingsHome(t, { JIRA_URL: jira.url, ...credentials });
    const child = spawn(process.execPath, [entry], { env: environment(home, jira.certificate), stdio: "pipe" });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const initialized = Promise.withResolvers<void>();
    const invalidOutput: string[] = [];
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown };
        if (message.id === 1 && message.result) initialized.resolve();
      } catch {
        invalidOutput.push(line);
      }
    });
    function send(message: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    }
    send({ id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "shutdown-test", version: "1.0.0" },
    } });
    await initialized.promise;
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "get_projects", arguments: {} } });
    await jira.seen;
    if (termination === "stdin") child.stdin.end();
    else child.kill(termination);
    const [code, signal] = await closed;
    await jira.disconnected;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.deepEqual(invalidOutput, []);
    assert.equal(stderr, "");
  });
}
