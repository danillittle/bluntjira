import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Only controlled messages from settings loading may be printed by the CLI.
export class SettingsError extends Error {}

export interface StoredSettings {
  JIRA_URL?: string;
  JIRA_USERNAME?: string;
  JIRA_PASSWORD?: string;
}

export function settingsPath(): string {
  return path.join(homedir(), ".bluntjira", "settings.json");
}

export async function readSettings(filePath = settingsPath()): Promise<StoredSettings> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new SettingsError("Jira settings file not found. Run the login command first.");
    }
    throw new SettingsError("Unable to read Jira settings file. Check file access and run the login command again.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new SettingsError("Invalid Jira settings JSON. Run the login command again.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsError("Invalid Jira settings JSON. Run the login command again.");
  }
  const settings = parsed as Record<string, unknown>;
  return {
    ...(typeof settings.JIRA_URL === "string" ? { JIRA_URL: settings.JIRA_URL } : {}),
    ...(typeof settings.JIRA_USERNAME === "string" ? { JIRA_USERNAME: settings.JIRA_USERNAME } : {}),
    ...(typeof settings.JIRA_PASSWORD === "string" ? { JIRA_PASSWORD: settings.JIRA_PASSWORD } : {}),
  };
}
