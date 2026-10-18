import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JiraClient } from "../src/jira-client.js";
import { registerTools } from "../src/tools.js";

const config = { url: "https://jira.example.com/jira", cookieName: "JSESSIONID", cookieValue: "test-session-token" };

async function connect(fetchImpl: typeof fetch) {
  const jira = new JiraClient(config, { fetch: fetchImpl });
  const server = new McpServer({ name: "bluntjira", version: "0.1.0" });
  registerTools(server, jira);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("MCP initializes, lists get_projects and calls it through the Jira HTTP boundary", async (t) => {
  const projects = [{ id: "10000", key: "TEST", name: "Test project" }];
  let calls = 0;
  const connection = await connect(async (input, init) => {
    calls++;
    assert.equal(input, "https://jira.example.com/jira/rest/api/2/project");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
    assert.equal(new Headers(init?.headers).get("Cookie"), `${config.cookieName}=${config.cookieValue}`);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.equal(init?.redirect, "manual");
    return Response.json(projects);
  });
  t.after(connection.close);

  const { tools } = await connection.client.listTools();
  assert.ok(tools.some((tool) => tool.name === "get_projects"));
  assert.equal(tools[0]?.annotations?.readOnlyHint, true);
  const result = await connection.client.callTool({ name: "get_projects", arguments: {} });
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(projects) }]);
  assert.notEqual(result.isError, true);
  assert.equal(calls, 1);
});

test("Jira execution errors become safe MCP tool errors", async (t) => {
  const connection = await connect(async () => Response.json({
    errorMessages: [`Permission denied: ${config.cookieValue}`],
  }, { status: 403 }));
  t.after(connection.close);
  const result = await connection.client.callTool({ name: "get_projects", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /HTTP 403/);
  assert.match(JSON.stringify(result.content), /Permission denied/);
  assert.ok(!JSON.stringify(result).includes(config.cookieValue));
});

test("MCP calls after an auth failure are rejected locally across tools", async (t) => {
  let calls = 0;
  const connection = await connect(async () => {
    calls++; return Response.json({}, { status: 401 });
  });
  t.after(connection.close);
  const first = await connection.client.callTool({ name: "get_projects", arguments: {} });
  const second = await connection.client.callTool({ name: "get_issue", arguments: { issueKey: "TEST-1" } });
  assert.equal(first.isError, true);
  assert.equal(second.isError, true);
  assert.match(JSON.stringify(second.content), /paused/);
  assert.match(JSON.stringify(second.content), /no HTTP request was sent/);
  assert.equal(calls, 1);
});

test("unknown top-level arguments are rejected before calling Jira", async (t) => {
  let calls = 0;
  const connection = await connect(async () => { calls++; return Response.json([]); });
  t.after(connection.close);
  const result = await connection.client.callTool({
    name: "get_projects", arguments: { url: "https://untrusted.example" },
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});
