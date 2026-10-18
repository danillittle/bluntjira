import assert from "node:assert/strict";
import { test } from "node:test";
import { loadJiraConfig } from "../src/jira-client.js";

const validSettings = {
  JIRA_URL: "https://jira.example.com/jira/",
  JIRA_COOKIE_NAME: "JSESSIONID",
  JIRA_COOKIE_VALUE: "opaque-session-token",
};

test("preserves Jira context path while loading cookie credentials", () => {
  assert.deepEqual(loadJiraConfig(validSettings), {
    url: "https://jira.example.com/jira",
    cookieName: validSettings.JIRA_COOKIE_NAME,
    cookieValue: validSettings.JIRA_COOKIE_VALUE,
  });
});

test("normalizes root URL without changing session cookie", () => {
  const config = loadJiraConfig({ ...validSettings, JIRA_URL: "https://jira.example.com///" });
  assert.equal(config.url, "https://jira.example.com");
  assert.equal(config.cookieValue, validSettings.JIRA_COOKIE_VALUE);
});

for (const key of ["JIRA_URL", "JIRA_COOKIE_NAME", "JIRA_COOKIE_VALUE"] as const) {
  for (const value of [undefined, "", "   "]) {
    test(`rejects ${key} when ${JSON.stringify(value)} without exposing cookie`, () => {
      assert.throws(() => loadJiraConfig({ ...validSettings, [key]: value }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(key));
        assert.ok(!error.message.includes(validSettings.JIRA_COOKIE_VALUE));
        return true;
      });
    });
  }
}

for (const url of [
  "not-a-url", "http://jira.example.com", "ftp://jira.example.com",
  "https://embedded-user:embedded-secret@jira.example.com/jira",
  "https://jira.example.com/jira?token=embedded-secret",
  "https://jira.example.com/jira#embedded-secret", "https://jira.example.com/jira?", "https://jira.example.com/jira#",
]) {
  test(`rejects unsafe or invalid URL ${url}`, () => {
    assert.throws(() => loadJiraConfig({ ...validSettings, JIRA_URL: url }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JIRA_URL/);
      assert.ok(!error.message.includes("embedded-secret"));
      assert.ok(!error.message.includes(url));
      return true;
    });
  });
}

test("rejects unsafe cookie name and value", () => {
  assert.throws(() => loadJiraConfig({ ...validSettings, JIRA_COOKIE_NAME: "bad name" }), /JIRA_COOKIE_NAME/);
  assert.throws(() => loadJiraConfig({ ...validSettings, JIRA_COOKIE_VALUE: "value; injected=true" }), /JIRA_COOKIE_VALUE/);
});

test("reports all missing settings without including secret values", () => {
  assert.throws(() => loadJiraConfig({ JIRA_URL: "invalid-url-secret" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const key of ["JIRA_URL", "JIRA_COOKIE_NAME", "JIRA_COOKIE_VALUE"]) assert.ok(error.message.includes(key));
    assert.ok(!error.message.includes("invalid-url-secret"));
    return true;
  });
});
