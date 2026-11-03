import assert from "node:assert/strict";
import { test } from "node:test";
import { loadJiraCredentials } from "../src/jira-client.js";

const validSettings = {
  JIRA_URL: "https://jira.example.com/jira/",
  JIRA_USERNAME: "alice",
  JIRA_PASSWORD: "opaque-password",
};

test("preserves Jira context path while loading credentials", () => {
  assert.deepEqual(loadJiraCredentials(validSettings), {
    url: "https://jira.example.com/jira",
    username: validSettings.JIRA_USERNAME,
    password: validSettings.JIRA_PASSWORD,
  });
});

test("normalizes root URL without changing password", () => {
  const config = loadJiraCredentials({ ...validSettings, JIRA_URL: "https://jira.example.com///" });
  assert.equal(config.url, "https://jira.example.com");
  assert.equal(config.password, validSettings.JIRA_PASSWORD);
});

for (const key of ["JIRA_URL", "JIRA_USERNAME", "JIRA_PASSWORD"] as const) {
  for (const value of key === "JIRA_PASSWORD" ? [undefined, ""] : [undefined, "", "   "]) {
    test(`rejects ${key} when ${JSON.stringify(value)} without exposing password`, () => {
      assert.throws(() => loadJiraCredentials({ ...validSettings, [key]: value }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(key));
        assert.ok(!error.message.includes(validSettings.JIRA_PASSWORD));
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
    assert.throws(() => loadJiraCredentials({ ...validSettings, JIRA_URL: url }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JIRA_URL/);
      assert.ok(!error.message.includes("embedded-secret"));
      assert.ok(!error.message.includes(url));
      return true;
    });
  });
}

test("reports all missing settings without including secret values", () => {
  assert.throws(() => loadJiraCredentials({ JIRA_URL: "invalid-url-secret" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const key of ["JIRA_URL", "JIRA_USERNAME", "JIRA_PASSWORD"]) assert.ok(error.message.includes(key));
    assert.ok(!error.message.includes("invalid-url-secret"));
    return true;
  });
});
