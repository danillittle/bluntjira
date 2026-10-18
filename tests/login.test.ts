import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { authenticateSession, saveSession, serializeSession } from "../src/login.js";
import { loadJiraConfig } from "../src/jira-client.js";

const session = { url: "https://jira.example.com/jira", cookieName: "JSESSIONID", cookieValue: "opaque-session" };

test("login exchanges credentials for a Jira session cookie", async () => {
  let request: RequestInit | undefined;
  const result = await authenticateSession(session.url, "test-user", "secret", async (input, init) => {
    assert.equal(input, `${session.url}/rest/auth/1/session`);
    request = init;
    return Response.json({ session: { name: session.cookieName, value: session.cookieValue } });
  });
  assert.deepEqual(result, session);
  assert.equal(request?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.body)), { username: "test-user", password: "secret" });
});

test("refuses insecure Jira URLs before sending login credentials", async () => {
  let called = false;
  await assert.rejects(authenticateSession("http://jira.example.com", "u", "p", async () => {
    called = true;
    return Response.json({});
  }), /HTTPS/);
  assert.equal(called, false);
});

test("does not accept failed or malformed Jira session responses", async () => {
  await assert.rejects(authenticateSession(session.url, "u", "p", async () => new Response("", { status: 401 })), /HTTP 401/);
  await assert.rejects(authenticateSession(session.url, "u", "p", async () => Response.json({})), /did not include a session cookie/);
});

for (const failure of ["network", "invalid-json", "body"] as const) {
  test(`login ${failure} errors do not expose untrusted details`, async () => {
    const marker = "sensitive-login-marker";
    await assert.rejects(authenticateSession(session.url, "u", "p", async () => {
      if (failure === "network") throw new Error(marker);
      if (failure === "invalid-json") return new Response(marker);
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error(marker)); },
      }));
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(marker));
      assert.ok(!error.message.includes("sensitive"));
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

for (const cookie of [
  { name: "bad;name", value: "token" },
  { name: "", value: "token" },
  ...["", "a;b", "a b", "a\r\nb", "a\u0000b", "a\u007fb", "cookie-é", "cookie-🔑"]
    .map((value) => ({ name: "JSESSIONID", value })),
]) {
  test(`login rejects unsafe session cookie ${JSON.stringify(cookie)}`, async () => {
    await assert.rejects(authenticateSession(session.url, "u", "p", async () => Response.json({ session: cookie })),
      /invalid session cookie/);
  });
}

test("a successful login session is accepted by the server configuration loader", async () => {
  const result = await authenticateSession(session.url, "u", "p", async () => Response.json({
    session: { name: session.cookieName, value: "opaque:$@#=+/%token" },
  }));
  assert.deepEqual(loadJiraConfig(JSON.parse(serializeSession(result))), result);
});

for (const phase of ["headers", "body"] as const) {
  test(`login applies one 30-second timeout while waiting for ${phase}, without retrying`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const bodyStarted = Promise.withResolvers<void>();
    const request = authenticateSession(session.url, "u", "p", async (_input, init) => {
      calls++;
      const signal = init?.signal;
      assert.ok(signal, "Login must pass an abort signal to fetch");
      if (phase === "headers") {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      // Header latency consumes part of the same deadline as body reading.
      t.mock.timers.tick(29_000);
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          bodyStarted.resolve();
        },
      }));
    });
    const rejected = assert.rejects(request, /Jira login timed out/);
    if (phase === "body") {
      // Also releases this wait if a missing abort signal made fetch fail early.
      await Promise.race([bodyStarted.promise, request.catch(() => {})]);
    }
    t.mock.timers.tick(phase === "headers" ? 30_000 : 1000);
    await rejected;
    assert.equal(calls, 1);
  });
}

test("successful login clears its timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null | undefined;
  await authenticateSession(session.url, "u", "p", async (_input, init) => {
    signal = init?.signal;
    return Response.json({ session: { name: session.cookieName, value: session.cookieValue } });
  });
  assert.ok(signal);
  t.mock.timers.tick(30_000);
  assert.equal(signal.aborted, false);
});

test("serializes only the Jira session as JSON, not username or password", () => {
  const serialized = serializeSession(session);
  assert.deepEqual(JSON.parse(serialized), {
    JIRA_URL: session.url,
    JIRA_COOKIE_NAME: session.cookieName,
    JIRA_COOKIE_VALUE: session.cookieValue,
  });
  assert.ok(!serialized.includes("JIRA_USER"));
  assert.ok(!serialized.includes("JIRA_PASS"));
});

test("saves the session with owner-only file permissions", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "bluntjira-login-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  await saveSession(session, file);
  assert.equal(await readFile(file, "utf8"), serializeSession(session));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
