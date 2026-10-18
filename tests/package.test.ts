import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMockJira } from "./fixtures/mock-jira.js";
import { createSettingsHome } from "./fixtures/settings.js";

const run = promisify(execFile);
// Publishing dry-runs must still exercise a real temporary archive and installation.
const npmEnvironment = { ...process.env, npm_config_dry_run: "false" };
const root = fileURLToPath(new URL("../../", import.meta.url));

test("packed npm archive contains only runtime files and its installed bin serves MCP", { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bluntjira-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root, timeout: 30_000, env: npmEnvironment });
  const [archive] = JSON.parse(stdout) as { filename: string; files: { path: string }[] }[];
  assert.ok(archive);
  const files = archive.files.map((file) => file.path).sort();
  assert.deepEqual(files, ["LICENSE", "README.md", "dist/cookie.js", "dist/index.js", "dist/jira-client.js", "dist/login.js", "dist/settings.js", "dist/tools.js", "package.json"]);
  const archivePath = join(directory, archive.filename);
  await run("npm", ["install", "--prefix", directory, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", archivePath], {
    timeout: 60_000, env: npmEnvironment,
  });
  const installed = JSON.parse(await readFile(join(directory, "node_modules/bluntjira/package.json"), "utf8")) as {
    bin: { bluntjira: string };
    version: string;
    license: string;
    author: string;
    repository: { type: string; url: string };
  };
  assert.equal(installed.bin.bluntjira, "dist/index.js");
  assert.equal(installed.license, "MIT");
  assert.equal(installed.author, "Danil Shagimardanov");
  assert.deepEqual(installed.repository, { type: "git", url: "git+https://github.com/danillittle/bluntjira.git" });
  assert.match(await readFile(join(directory, "node_modules/bluntjira/LICENSE"), "utf8"),
    /Copyright \(c\) 2026 Danil Shagimardanov/);
  assert.ok((await readFile(join(directory, "node_modules/bluntjira/dist/index.js"), "utf8")).startsWith("#!/usr/bin/env node\n"));

  const jira = await createMockJira();
  t.after(jira.close);
  const home = await createSettingsHome(t, { JIRA_URL: jira.url, JIRA_COOKIE_NAME: "JSESSIONID", JIRA_COOKIE_VALUE: "package-test-session" });
  const transport = new StdioClientTransport({
    command: join(directory, "node_modules/.bin/bluntjira"), args: [], cwd: directory, stderr: "pipe",
    env: { NODE_EXTRA_CA_CERTS: jira.certificate, HOME: home, USERPROFILE: home },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "package-smoke", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, installed.version, "MCP version must match the published package");
  assert.equal((await client.listTools()).tools.length, 9);
  const result = await client.callTool({ name: "get_projects", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify([{ key: "TEST", name: "Mock Jira" }]) }]);
  assert.equal(jira.requests.length, 1);
  assert.equal(jira.requests[0]?.path, "/jira/rest/api/2/project");
  assert.equal(jira.requests[0]?.cookie, "JSESSIONID=package-test-session");
  assert.equal(stderr, "");
});
