import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JiraClient, JiraRequestError } from "../src/jira-client.js";

const config = { url: "https://jira.example.com", cookieName: "JSESSIONID", cookieValue: "test-session-token" };
function clock() {
  let time = Date.parse("2026-01-01T00:00:00Z");
  const waits: number[] = [];
  return {
    now: () => time,
    advance: (ms: number) => { time += ms; },
    waits,
    wait: async (ms: number, _signal: AbortSignal) => { waits.push(ms); time += ms; },
  };
}

for (const status of [429, 502, 503, 504]) {
  test(`read HTTP ${status} uses bounded exponential backoff and recovers`, async () => {
    const time = clock();
    let calls = 0;
    const jira = new JiraClient(config, { ...time, fetch: async () => {
      calls++;
      return calls < 3 ? Response.json({}, { status }) : Response.json([{ key: "TEST" }]);
    } });
    assert.deepEqual(await jira.getProjects(), [{ key: "TEST" }]);
    assert.equal(calls, 3);
    assert.equal(time.waits.length, 2);
    assert.ok(time.waits[0]! >= 1000 && time.waits[0]! <= 1250);
    assert.ok(time.waits[1]! >= 2000 && time.waits[1]! <= 2250);
  });
}

test("exhausted reads stop after three attempts and retain Jira diagnostics", async () => {
  const time = clock();
  let calls = 0;
  const jira = new JiraClient(config, { ...time, fetch: async () => {
    calls++; return Response.json({ errorMessages: ["Unavailable"] }, { status: 503 });
  } });
  await assert.rejects(jira.getProjects(), /HTTP 503: Unavailable/);
  assert.equal(calls, 3);
  assert.equal(time.waits.length, 2);
});

for (const header of ["5", "Thu, 01 Jan 2026 00:00:05 GMT"]) {
  test(`Retry-After ${header} is respected before retry`, async () => {
    const time = clock();
    let calls = 0;
    const jira = new JiraClient(config, { ...time, fetch: async () => {
      calls++;
      return calls === 1 ? Response.json({}, { status: 429, headers: { "Retry-After": header } }) : Response.json([]);
    } });
    await jira.getProjects();
    assert.equal(calls, 2);
    assert.deepEqual(time.waits, [5000]);
  });
}

test("Retry-After beyond the operation budget returns the error without an early retry", async () => {
  const time = clock();
  let calls = 0;
  const jira = new JiraClient(config, { ...time, fetch: async () => {
    calls++; return Response.json({}, { status: 429, headers: { "Retry-After": "60" } });
  } });
  await assert.rejects(jira.getProjects(), /Retry-After: 60/);
  assert.equal(calls, 1);
  assert.deepEqual(time.waits, []);
});

test("invalid Retry-After falls back to normal backoff", async () => {
  const time = clock();
  let calls = 0;
  const jira = new JiraClient(config, { ...time, fetch: async () => {
    calls++;
    return calls === 1 ? Response.json({}, { status: 503, headers: { "Retry-After": "invalid" } }) : Response.json([]);
  } });
  await jira.getProjects();
  assert.equal(calls, 2);
  assert.ok(time.waits[0]! >= 1000 && time.waits[0]! <= 1250);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} is never retried and pauses reads and writes for five minutes`, async () => {
    const time = clock();
    let calls = 0;
    const jira = new JiraClient(config, { ...time, fetch: async () => {
      calls++;
      return calls === 1 ? Response.json({}, { status }) : Response.json([]);
    } });
    await assert.rejects(jira.getProjects(), status === 401
      ? /HTTP 401.*session may have expired.*bluntjira login/
      : /HTTP 403.*paused/);
    await assert.rejects(jira.getIssue("TEST-1"), (error: unknown) => {
      assert.ok(error instanceof JiraRequestError);
      assert.equal(error.kind, "cooldown");
      assert.match(error.message, /300 seconds/);
      return true;
    });
    await assert.rejects(jira.createIssue({ summary: "Not sent" }), /paused/);
    assert.equal(calls, 1);
    time.advance(299_999);
    await assert.rejects(jira.getProjects(), /paused/);
    assert.equal(calls, 1);
    time.advance(1);
    assert.deepEqual(await jira.getProjects(), []);
    assert.equal(calls, 2);
    assert.deepEqual(time.waits, []);
  });
}

for (const status of [400, 404, 500]) {
  test(`HTTP ${status} does not retry or start an authentication pause`, async () => {
    const time = clock();
    let calls = 0;
    const jira = new JiraClient(config, { ...time, fetch: async () => {
      calls++; return Response.json({}, { status });
    } });
    await assert.rejects(jira.getProjects(), new RegExp(`HTTP ${status}`));
    await assert.rejects(jira.getProjects(), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 2);
    assert.deepEqual(time.waits, []);
  });
}

for (const status of [429, 502, 503, 504]) {
  test(`writes are not retried on HTTP ${status}`, async () => {
    const time = clock();
    let calls = 0;
    const jira = new JiraClient(config, { ...time, fetch: async () => {
      calls++; return Response.json({}, { status });
    } });
    await assert.rejects(jira.createIssue({ summary: "Test" }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
    assert.deepEqual(time.waits, []);
  });
}

test("POST JQL is retried as a read with unchanged request body", async () => {
  const time = clock();
  const bodies: unknown[] = [];
  const jira = new JiraClient(config, { ...time, fetch: async (_input, init) => {
    assert.equal(init?.method, "POST");
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? Response.json({}, { status: 503 }) : Response.json({ issues: [] });
  } });
  const input = { jql: "project = TEST", startAt: 10, maxResults: 50 };
  await jira.searchIssues(input);
  assert.deepEqual(bodies, [input, input]);
});

test("close cancels backoff immediately without another HTTP call", async () => {
  let calls = 0;
  const waiting = Promise.withResolvers<void>();
  const jira = new JiraClient(config, {
    fetch: async () => { calls++; return Response.json({}, { status: 503 }); },
    wait: async (ms, signal) => { waiting.resolve(); await delay(ms, undefined, { signal }); },
  });
  const request = jira.getProjects();
  await waiting.promise;
  jira.close();
  await assert.rejects(request, /cancelled/);
  assert.equal(calls, 1);
});

test("the operation timeout also cancels an active backoff wait", { timeout: 4000 }, async (t) => {
  let calls = 0;
  const jira = new JiraClient(config, {
    timeoutMs: 1500,
    fetch: async () => { calls++; return Response.json({}, { status: 503 }); },
    wait: async (_ms, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  t.after(() => jira.close());
  await assert.rejects(jira.getProjects(), (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.kind, "timeout");
    return true;
  });
  assert.equal(calls, 1);
});

test("the total time budget is not reset between attempts", async () => {
  const time = clock();
  let calls = 0;
  const jira = new JiraClient(config, { ...time, fetch: async () => {
    calls++;
    time.advance(14_000);
    return Response.json({}, { status: 503 });
  } });
  await assert.rejects(jira.getProjects(), /HTTP 503/);
  assert.equal(calls, 2);
  assert.equal(time.waits.length, 1);
});

test("auth headers start the pause even if the response body fails", async () => {
  let calls = 0;
  const jira = new JiraClient(config, { fetch: async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.error(new Error("broken body")); },
    }), { status: 401 });
  } });
  await assert.rejects(jira.getProjects(), /Unable to reach Jira/);
  await assert.rejects(jira.getProjects(), /paused/);
  assert.equal(calls, 1);
});

test("an auth failure from a write also pauses subsequent reads", async () => {
  let calls = 0;
  const jira = new JiraClient(config, { fetch: async () => {
    calls++; return Response.json({}, { status: 403 });
  } });
  await assert.rejects(jira.addComment("TEST-1", "Not retried"), /HTTP 403.*paused/);
  await assert.rejects(jira.getProjects(), /paused/);
  assert.equal(calls, 1);
});

test("another request's auth failure prevents a pending retry", async () => {
  const time = clock();
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let calls = 0;
  const jira = new JiraClient(config, {
    now: time.now,
    wait: async () => { waiting.resolve(); await resume.promise; },
    fetch: async () => { calls++; return Response.json({}, { status: calls === 1 ? 503 : 401 }); },
  });
  const read = jira.getProjects();
  await waiting.promise;
  await assert.rejects(jira.getIssue("TEST-1"), /HTTP 401/);
  resume.resolve();
  await assert.rejects(read, /paused/);
  assert.equal(calls, 2);
});
