import assert from "node:assert/strict";
import { test } from "node:test";
import { JiraClient, JiraRequestError } from "../src/jira-client.js";

const config = { url: "https://jira.example.com/jira", cookieName: "JSESSIONID", cookieValue: "test-session:$@#" };

for (const status of [400, 401, 403, 404, 429, 500, 503]) {
  test(`reports HTTP ${status}, preserving safe Jira errors under the retry policy`, async () => {
    let calls = 0;
    const jira = new JiraClient(config, { wait: async () => {}, fetch: async () => {
      calls++;
      return Response.json({ errorMessages: ["Request rejected"], errors: { summary: "Required field" } }, {
        status, headers: { "Retry-After": "15" },
      });
    } });
    await assert.rejects(jira.getProjects(), (error: unknown) => {
      assert.ok(error instanceof JiraRequestError);
      assert.equal(error.kind, "http");
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /Request rejected/);
      assert.match(error.message, /summary: Required field/);
      if (status === 429) assert.match(error.message, /Retry-After: 15/);
      return true;
    });
    assert.equal(calls, status === 429 || status === 503 ? 3 : 1);
  });
}

test("redacts credentials in Jira errors and Retry-After", async () => {
  const jira = new JiraClient(config, { wait: async () => {}, fetch: async () => Response.json({
    errorMessages: [config.cookieValue],
    errors: { [config.cookieValue]: config.cookieValue },
  }, { status: 429, headers: { "Retry-After": config.cookieValue } }) });
  await assert.rejects(jira.getProjects(), (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    for (const secret of [config.cookieValue, `${config.cookieName}=${config.cookieValue}`]) {
      assert.ok(!error.message.includes(secret));
    }
    assert.match(error.message, /\[REDACTED\]/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("replaces ASCII control characters in Jira errors without changing Unicode text", async () => {
  const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("") + String.fromCharCode(127);
  const text = "Ошибка Jira: café 😀" + String.fromCharCode(128, 159);
  const jira = new JiraClient(config, { fetch: async () => Response.json({
    errorMessages: [controls + text],
  }, { status: 400 }) });
  await assert.rejects(jira.getProjects(), (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.message, "Jira HTTP 400: " + " ".repeat(33) + text);
    return true;
  });
});

test("does not expose raw HTML or malformed Jira error bodies", async () => {
  for (const body of ["<html>private-login-page</html>", "{broken-json", '{"errors":{"bad":{"nested":"private"}}}']) {
    const jira = new JiraClient(config, { fetch: async () => new Response(body, { status: 500 }) });
    await assert.rejects(jira.getProjects(), (error: unknown) => {
      assert.ok(error instanceof JiraRequestError);
      assert.match(error.message, /HTTP 500/);
      assert.ok(!error.message.includes("private"));
      assert.ok(!error.message.includes("broken-json"));
      return true;
    });
  }
});

test("refuses redirects without making a second request", async () => {
  let calls = 0;
  const jira = new JiraClient(config, { fetch: async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://other.example" } });
  } });
  await assert.rejects(jira.getProjects(), (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.kind, "redirect");
    assert.match(error.message, /JIRA_URL/);
    assert.ok(!error.message.includes("other.example"));
    return true;
  });
  assert.equal(calls, 1);
});

for (const response of [() => new Response(null, { status: 204 }), () => new Response("")]) {
  test("returns a success marker for an empty successful response", async () => {
    const jira = new JiraClient(config, { fetch: async () => response() });
    assert.deepEqual(await jira.getProjects(), { success: true });
  });
}

test("rejects invalid JSON in a successful response without exposing its body", async () => {
  const jira = new JiraClient(config, { fetch: async () => new Response("<html>private</html>") });
  await assert.rejects(jira.getProjects(), (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.kind, "format");
    assert.ok(!error.message.includes("private"));
    return true;
  });
});

test("network failures expose no original error and are not retried", async () => {
  let calls = 0;
  const jira = new JiraClient(config, { fetch: async () => {
    calls++;
    throw new Error(`socket failed: ${config.cookieValue}`);
  } });
  await assert.rejects(jira.getProjects(), (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.kind, "network");
    assert.ok(!error.message.includes(config.cookieValue));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test("aborts a pending request at the configured timeout without retries", async () => {
  let calls = 0;
  const jira = new JiraClient(config, { timeoutMs: 10, fetch: async (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } });
  await assert.rejects(jira.getProjects(), (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.kind, "timeout");
    return true;
  });
  assert.equal(calls, 1);
});

test("close cancels all active requests, is idempotent and prevents new HTTP calls", async () => {
  let calls = 0;
  const jira = new JiraClient(config, { fetch: async (_input, init) => {
    calls++;
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } });
  const read = jira.getProjects();
  const write = jira.createIssue({ summary: "Test" });
  jira.close();
  jira.close();
  await assert.rejects(read, (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.kind, "cancelled");
    assert.doesNotMatch(error.message, /outcome is unknown/);
    return true;
  });
  await assert.rejects(write, /Write outcome is unknown/);
  await assert.rejects(jira.getProjects(), /client is closed/);
  assert.equal(calls, 2);
});

test("timeout remains active while the response body is being read", async () => {
  const jira = new JiraClient(config, { timeoutMs: 10, fetch: async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }));
  } });
  await assert.rejects(jira.getProjects(), (error: unknown) => {
    assert.ok(error instanceof JiraRequestError);
    assert.equal(error.kind, "timeout");
    return true;
  });
});
