import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JiraClient } from "../src/jira-client.js";
import { registerTools } from "../src/tools.js";

const config = { url: "https://jira.example.com/jira", cookieName: "JSESSIONID", cookieValue: "test-session-token" };

async function connect(fetchImpl: typeof fetch, timeoutMs = 30_000) {
  const server = new McpServer({ name: "bluntjira", version: "0.1.0" });
  registerTools(server, new JiraClient(config, { fetch: fetchImpl, timeoutMs }));
  const client = new Client({ name: "operations-test", version: "1.0.0" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("get_issue encodes the key and fields while returning Jira data unchanged", async (t) => {
  const issue = { key: "TEST-1", fields: { customfield_100: { nested: [null, true] } } };
  let calls = 0;
  const connection = await connect(async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/jira/rest/api/2/issue/TEST%2F1%3F%23");
    assert.equal(url.searchParams.get("fields"), "summary,customfield_100");
    assert.equal(init?.method, "GET");
    return Response.json(issue);
  });
  t.after(connection.close);
  const result = await connection.client.callTool({ name: "get_issue", arguments: {
    issueKey: "TEST/1?#", fields: ["summary", "customfield_100"],
  } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(issue) }]);
  assert.equal(calls, 1);
});

for (const args of [
  { jql: 'project = TEST AND summary ~ "a&b"' },
  { jql: "project = TEST", startAt: 10, maxResults: 100, fields: ["summary"] },
]) {
  test(`search_issues sends a single POST with pagination ${JSON.stringify(args)}`, async (t) => {
    const page = { startAt: args.startAt ?? 0, maxResults: 2, total: 500, issues: [{ key: "TEST-1" }] };
    let calls = 0;
    const connection = await connect(async (input, init) => {
      calls++;
      assert.equal(input, `${config.url}/rest/api/2/search`);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ...args, startAt: args.startAt ?? 0, maxResults: args.maxResults ?? 50,
      });
      return Response.json(page);
    });
    t.after(connection.close);
    const result = await connection.client.callTool({ name: "search_issues", arguments: args });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(page) }]);
    assert.equal(calls, 1);
  });
}

for (const [name, args] of [
  ["get_issue", {}],
  ["get_issue", { issueKey: " " }],
  ["get_issue", { issueKey: ".." }],
  ["get_issue", { issueKey: "TEST-1", fields: "summary" }],
  ["search_issues", { jql: " " }],
  ["search_issues", { jql: "project = TEST", startAt: -1 }],
  ["search_issues", { jql: "project = TEST", startAt: 1.5 }],
  ["search_issues", { jql: "project = TEST", maxResults: 0 }],
  ["search_issues", { jql: "project = TEST", maxResults: 101 }],
  ["search_issues", { jql: "project = TEST", extra: true }],
] as const) {
  test(`${name} rejects invalid arguments ${JSON.stringify(args)} before HTTP`, async (t) => {
    let calls = 0;
    const connection = await connect(async () => { calls++; return Response.json({}); });
    t.after(connection.close);
    const result = await connection.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
  });
}

const createFields = {
  project: { key: "TEST" }, summary: "Create from MCP", issuetype: { name: "Task" },
  customfield_100: { nested: [null, "text", 42] },
};

for (const operation of [
  { name: "create_issue", args: { fields: createFields }, method: "POST", path: "/issue", status: 201,
    body: { fields: createFields }, result: { id: "10000", key: "TEST-1" } },
  { name: "update_issue", args: { issueKey: "TEST-1", fields: { description: null, customfield_100: ["x"] } },
    method: "PUT", path: "/issue/TEST-1", status: 204,
    body: { fields: { description: null, customfield_100: ["x"] } }, result: { success: true } },
]) {
  test(`${operation.name} sends exact fields and preserves custom JSON`, async (t) => {
    let calls = 0;
    const connection = await connect(async (input, init) => {
      calls++;
      assert.equal(input, `${config.url}/rest/api/2${operation.path}`);
      assert.equal(init?.method, operation.method);
      assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), operation.body);
      return operation.status === 204 ? new Response(null, { status: 204 })
        : Response.json(operation.result, { status: operation.status });
    });
    t.after(connection.close);
    const result = await connection.client.callTool({ name: operation.name, arguments: operation.args });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(operation.result) }]);
    assert.equal(calls, 1);
  });
}

for (const [name, args] of [
  ["create_issue", { fields: {} }],
  ["create_issue", { fields: { ...createFields, summary: " " } }],
  ["create_issue", { fields: { ...createFields, project: {} } }],
  ["create_issue", { fields: { ...createFields, issuetype: {} } }],
  ["create_issue", { fields: { ...createFields, project: { id: "" } } }],
  ["create_issue", { fields: createFields, extra: true }],
  ["update_issue", { issueKey: "TEST-1", fields: {} }],
  ["update_issue", { issueKey: "TEST-1", fields: { status: { id: "3" } } }],
  ["update_issue", { issueKey: "TEST-1", fields: [] }],
  ["update_issue", { issueKey: "TEST-1", fields: { summary: "x" }, extra: true }],
] as const) {
  test(`${name} rejects invalid write arguments ${JSON.stringify(args)}`, async (t) => {
    let calls = 0;
    const connection = await connect(async () => { calls++; return Response.json({}); });
    t.after(connection.close);
    const result = await connection.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
  });
}

for (const failure of ["network", "timeout", "body-timeout", "invalid-json"] as const) {
  test(`write ${failure} reports unknown outcome and does not retry`, async (t) => {
    let calls = 0;
    const connection = await connect(async (_input, init) => {
      calls++;
      if (failure === "network") throw new Error(`transport leaked ${config.cookieValue}`);
      if (failure === "invalid-json") return new Response("<html>private</html>", { status: 201 });
      const signal = init?.signal;
      assert.ok(signal);
      if (failure === "body-timeout") {
        return new Response(new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }), { status: 201 });
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }, 10);
    t.after(connection.close);
    const result = await connection.client.callTool({ name: "create_issue", arguments: { fields: createFields } });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result.content);
    assert.match(text, /outcome is unknown/i);
    assert.match(text, /check.*before.*retry/i);
    assert.ok(!text.includes(config.cookieValue));
    assert.ok(!text.includes("private"));
    assert.equal(calls, 1);
  });
}

test("POST JQL search is read-only even when a network error occurs", async (t) => {
  const connection = await connect(async () => { throw new Error("offline"); });
  t.after(connection.close);
  const result = await connection.client.callTool({ name: "search_issues", arguments: { jql: "project = TEST" } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result.content), /outcome is unknown/i);
});

test("Jira field validation errors from writes retain safe diagnostics", async (t) => {
  const connection = await connect(async () => Response.json({ errors: { customfield_100: "Required" } }, { status: 400 }));
  t.after(connection.close);
  const result = await connection.client.callTool({ name: "create_issue", arguments: { fields: createFields } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /customfield_100: Required/);
  assert.doesNotMatch(JSON.stringify(result.content), /outcome is unknown/i);
});

for (const operation of [
  { name: "get_comments", args: { issueKey: "TEST-1" }, method: "GET", path: "/issue/TEST-1/comment?startAt=0&maxResults=50",
    body: undefined, result: { startAt: 0, maxResults: 50, total: 100, comments: [{ body: "Hello" }] } },
  { name: "get_comments", args: { issueKey: "TEST-1", startAt: 50, maxResults: 1 }, method: "GET",
    path: "/issue/TEST-1/comment?startAt=50&maxResults=1", body: undefined, result: { startAt: 50, total: 100, comments: [] } },
  { name: "add_comment", args: { issueKey: "TEST-1", body: "Jira *wiki*\nSecond line" }, method: "POST", path: "/issue/TEST-1/comment",
    body: { body: "Jira *wiki*\nSecond line" }, result: { id: "10001", body: "Jira *wiki*\nSecond line" } },
  { name: "get_transitions", args: { issueKey: "TEST-1" }, method: "GET", path: "/issue/TEST-1/transitions?expand=transitions.fields",
    body: undefined, result: { transitions: [{ id: "31", fields: { resolution: { required: true } } }] } },
  { name: "transition_issue", args: { issueKey: "TEST-1", transitionId: "31", fields: { resolution: { name: "Done" }, customfield_100: null } },
    method: "POST", path: "/issue/TEST-1/transitions", body: { transition: { id: "31" }, fields: { resolution: { name: "Done" }, customfield_100: null } },
    result: null },
  { name: "transition_issue", args: { issueKey: "TEST-1", transitionId: "31" }, method: "POST", path: "/issue/TEST-1/transitions",
    body: { transition: { id: "31" } }, result: null },
]) {
  test(`${operation.name} preserves the REST contract ${operation.path}`, async (t) => {
    let calls = 0;
    const connection = await connect(async (input, init) => {
      calls++;
      assert.equal(input, `${config.url}/rest/api/2${operation.path}`);
      assert.equal(init?.method, operation.method);
      assert.deepEqual(init?.body === undefined ? undefined : JSON.parse(String(init.body)), operation.body);
      assert.equal(new Headers(init?.headers).get("Content-Type"), operation.body ? "application/json" : null);
      return operation.result === null ? new Response(null, { status: 204 }) : Response.json(operation.result);
    });
    t.after(connection.close);
    const result = await connection.client.callTool({ name: operation.name, arguments: operation.args });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(operation.result ?? { success: true }) }]);
    assert.equal(calls, 1);
  });
}

for (const [name, args] of [
  ["get_comments", {}],
  ["get_comments", { issueKey: "TEST-1", maxResults: 101 }],
  ["get_comments", { issueKey: "TEST-1", maxResults: 0 }],
  ["get_comments", { issueKey: "TEST-1", startAt: -1 }],
  ["get_comments", { issueKey: "TEST-1", extra: true }],
  ["add_comment", { issueKey: "TEST-1", body: " " }],
  ["add_comment", { issueKey: "TEST-1", body: {} }],
  ["add_comment", { issueKey: "TEST-1", body: "Hi", extra: true }],
  ["get_transitions", { issueKey: "" }],
  ["get_transitions", { issueKey: "TEST-1", extra: true }],
  ["transition_issue", { issueKey: "TEST-1", transitionId: " " }],
  ["transition_issue", { issueKey: "TEST-1", transitionId: 31 }],
  ["transition_issue", { issueKey: "TEST-1", transitionId: "31", fields: [] }],
  ["transition_issue", { issueKey: "TEST-1", transitionId: "31", extra: true }],
] as const) {
  test(`${name} rejects invalid comment/transition arguments ${JSON.stringify(args)}`, async (t) => {
    let calls = 0;
    const connection = await connect(async () => { calls++; return Response.json({}); });
    t.after(connection.close);
    const result = await connection.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
  });
}

test("exactly nine tools are exposed with conservative read/write annotations", async (t) => {
  const connection = await connect(async () => Response.json({}));
  t.after(connection.close);
  const { tools } = await connection.client.listTools();
  const reads = ["get_projects", "get_issue", "search_issues", "get_comments", "get_transitions"];
  const writes = ["create_issue", "update_issue", "add_comment", "transition_issue"];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...reads, ...writes].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, reads.includes(tool.name));
    if (writes.includes(tool.name)) {
      assert.equal(tool.annotations?.destructiveHint, true);
      assert.equal(tool.annotations?.idempotentHint, false);
    }
  }
});

for (const operation of [
  { name: "update_issue", args: { issueKey: "TEST-1", fields: { summary: "Changed" } } },
  { name: "add_comment", args: { issueKey: "TEST-1", body: "Hi" } },
  { name: "transition_issue", args: { issueKey: "TEST-1", transitionId: "31" } },
]) {
  test(`${operation.name} treats server failure as an unknown write outcome without retry`, async (t) => {
    let calls = 0;
    const connection = await connect(async () => { calls++; return Response.json({ errorMessages: ["Internal failure"] }, { status: 500 }); });
    t.after(connection.close);
    const result = await connection.client.callTool({ name: operation.name, arguments: operation.args });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /HTTP 500/);
    assert.match(JSON.stringify(result.content), /outcome is unknown/i);
    assert.equal(calls, 1);
  });
}
