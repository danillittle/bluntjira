import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readSettings } from "../src/settings.js";

const settings = { JIRA_URL: "https://jira.example.com", JIRA_COOKIE_NAME: "JSESSIONID", JIRA_COOKIE_VALUE: "session-value" };

test("reads JSON settings and ignores unrelated fields", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "bluntjira-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  await writeFile(file, JSON.stringify({ ...settings, unrelated: "ignored" }));
  assert.deepEqual(await readSettings(file), settings);
});

test("suggests login when the settings file does not exist", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "bluntjira-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(readSettings(path.join(directory, "missing.json")), /settings.*login/i);
});

test("rejects malformed JSON without exposing file contents", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "bluntjira-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  await writeFile(file, '{"secret":"must-not-leak"');
  await assert.rejects(readSettings(file), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Invalid Jira settings JSON. Run the login command again.");
    assert.ok(!error.message.includes("must-not-leak"));
    return true;
  });
});
