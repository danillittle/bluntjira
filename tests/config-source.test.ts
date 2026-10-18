import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createSettingsHome } from "./fixtures/settings.js";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const settings = { JIRA_URL: "https://jira.example.com", JIRA_COOKIE_NAME: "JSESSIONID", JIRA_COOKIE_VALUE: "file-session" };

function launch(home: string, overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [entry], {
    env: { HOME: home, USERPROFILE: home, ...overrides },
    input: "", encoding: "utf8", timeout: 3000,
  });
}

test("CLI ignores Jira environment variables when settings are valid", async (t) => {
  const home = await createSettingsHome(t, settings);
  const result = launch(home, { JIRA_URL: "http://invalid.example.com", JIRA_COOKIE_NAME: "bad;name", JIRA_COOKIE_VALUE: "bad;cookie" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("Jira environment variables cannot replace a missing settings file", async (t) => {
  const home = await createSettingsHome(t);
  const result = launch(home, settings);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /settings.*login/i);
  assert.ok(!result.stderr.includes(settings.JIRA_COOKIE_VALUE));
});

test("Jira environment variables cannot repair invalid file settings", async (t) => {
  const home = await createSettingsHome(t, { ...settings, JIRA_URL: "invalid-url-secret" });
  const result = launch(home, settings);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /settings.*JIRA_URL.*login/i);
  for (const secret of [settings.JIRA_COOKIE_VALUE, "invalid-url-secret"]) assert.ok(!result.stderr.includes(secret));
});

test("CLI reports malformed settings safely and suggests login", async (t) => {
  const home = await createSettingsHome(t, settings);
  await writeFile(path.join(home, ".bluntjira", "settings.json"), '{"secret":"must-not-leak"');
  const result = launch(home);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /settings.*login/i);
  assert.ok(!result.stderr.includes("must-not-leak"));
});
