import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createMockJira } from "./fixtures/mock-jira.js";
import { createSettingsHome } from "./fixtures/settings.js";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const settings = { JIRA_URL: "https://jira.example.com", JIRA_USERNAME: "alice", JIRA_PASSWORD: "file-password" };

function launch(home: string, overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [entry], {
    env: { HOME: home, USERPROFILE: home, ...overrides },
    input: "", encoding: "utf8", timeout: 3000,
  });
}

test("CLI ignores Jira environment variables when settings are valid", async (t) => {
  const jira = await createMockJira();
  t.after(jira.close);
  const home = await createSettingsHome(t, { ...settings, JIRA_URL: jira.url });
  // Async spawn: the in-process mock Jira must keep serving the login request.
  const child = spawn(process.execPath, [entry], {
    env: { HOME: home, USERPROFILE: home, JIRA_URL: "http://invalid.example.com", JIRA_USERNAME: "bad", JIRA_PASSWORD: "bad", NODE_EXTRA_CA_CERTS: jira.certificate },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.end();
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.equal(stderr, "");
});

test("Jira environment variables cannot replace a missing settings file", async (t) => {
  const home = await createSettingsHome(t);
  const result = launch(home, settings);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /settings.*login/i);
  assert.ok(!result.stderr.includes(settings.JIRA_PASSWORD));
});

test("Jira environment variables cannot repair invalid file settings", async (t) => {
  const home = await createSettingsHome(t, { ...settings, JIRA_URL: "invalid-url-secret" });
  const result = launch(home, settings);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /settings.*JIRA_URL.*login/i);
  for (const secret of [settings.JIRA_PASSWORD, "invalid-url-secret"]) assert.ok(!result.stderr.includes(secret));
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
