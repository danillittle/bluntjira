import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export async function createSettingsHome(t: TestContext, settings?: unknown): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "bluntjira-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (settings !== undefined) {
    await mkdir(path.join(home, ".bluntjira"), { mode: 0o700 });
    await writeFile(path.join(home, ".bluntjira", "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  }
  return home;
}
