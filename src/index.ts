#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JiraClient, loadJiraCredentials } from "./jira-client.js";
import { registerTools } from "./tools.js";
import { authenticateSession, LoginError, runLogin } from "./login.js";
import { readSettings, SettingsError } from "./settings.js";

// Source: https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md#stdio
async function main(): Promise<void> {
  const settings = await readSettings();
  const credentials = loadJiraCredentials(settings);
  const authenticate = () => authenticateSession(credentials.url, credentials.username, credentials.password);
  const server = new McpServer({ name: "bluntjira", version: "0.2.0" });
  const jira = new JiraClient({ url: credentials.url }, { reauth: authenticate });
  registerTools(server, jira);
  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.off("end", stop);
    process.stdin.off("close", stop);
    jira.close();
    await server.close();
  }
  function stop(): void {
    void shutdown().catch(() => {
      process.stderr.write("Unable to close bluntjira cleanly\n");
      process.exitCode = 1;
    });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // SDK stdio handles data/errors, but EOF needs an explicit shutdown hook.
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  server.server.onclose = stop;
  try {
    await server.connect(new StdioServerTransport());
  } catch (error: unknown) {
    await shutdown();
    throw error;
  }
}

if (process.argv[2] === "login") {
  runLogin().catch((error: unknown) => {
    const message = error instanceof LoginError ? error.message : "Unable to complete Jira login";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
} else {
  main().catch((error: unknown) => {
    const message = error instanceof SettingsError || error instanceof LoginError || (error instanceof Error && error.message.startsWith("Invalid Jira settings:"))
      ? error.message
      : "Unable to start bluntjira";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
