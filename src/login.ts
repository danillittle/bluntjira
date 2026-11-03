import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { StringDecoder } from "node:string_decoder";
import { sessionCookieSchema } from "./cookie.js";

// Only messages constructed by login itself are safe to print in the CLI.
export class LoginError extends Error {
  // True when Jira refused the credentials themselves (not a network or format problem).
  constructor(message: string, readonly rejected = false) {
    super(message);
  }
}

export interface LoginResult {
  url: string;
  cookieName: string;
  cookieValue: string;
}

export interface StoredCredentials {
  url: string;
  username: string;
  password: string;
}

export function serializeCredentials(credentials: StoredCredentials): string {
  return `${JSON.stringify({
    JIRA_URL: credentials.url,
    JIRA_USERNAME: credentials.username,
    JIRA_PASSWORD: credentials.password,
  }, null, 2)}\n`;
}

export async function authenticateSession(
  url: string,
  user: string,
  password: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<LoginResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new LoginError("Jira URL must be a valid HTTPS URL");
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new LoginError("Jira URL must be HTTPS and must not contain credentials, query, or fragment");
  }
  const baseUrl = parsedUrl.href.replace(/\/+$/, "");
  const controller = new AbortController();
  // One deadline includes both receiving headers and consuming the response body.
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(`${baseUrl}/rest/auth/1/session`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new LoginError(`Jira login failed (HTTP ${response.status})`, response.status === 401 || response.status === 403);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LoginError("Unable to read a valid Jira login response");
    }
    if (!payload || typeof payload !== "object" || !("session" in payload)) {
      throw new LoginError("Jira login response did not include a session cookie");
    }
    const session = sessionCookieSchema.safeParse(payload.session);
    if (!session.success) {
      throw new LoginError("Jira login response contained an invalid session cookie");
    }
    return { url: baseUrl, cookieName: session.data.name, cookieValue: session.data.value };
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new LoginError("Jira login timed out");
    if (error instanceof LoginError) throw error;
    // Original transport/parser exceptions may include credentials or response data.
    throw new LoginError("Unable to reach Jira for login");
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveCredentials(
  credentials: StoredCredentials,
  filePath = path.join(homedir(), ".bluntjira", "settings.json"),
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(filePath, serializeCredentials(credentials), { mode: 0o600 });
  await chmod(filePath, 0o600);
}

type TerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export async function readHidden(
  prompt: string,
  input: TerminalInput = stdin,
  output: Pick<NodeJS.WritableStream, "write"> = stdout,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") throw new LoginError("Login requires an interactive terminal");
  input.setRawMode(true);
  return await new Promise<string>((resolve, reject) => {
    const characters: string[] = [];
    // A UTF-8 character can span data events; iterate decoded code points, not bytes.
    const decoder = new StringDecoder("utf8");
    const onData = (chunk: Buffer) => {
      for (const character of decoder.write(chunk)) {
        if (character === "\u0003") { cleanup(); output.write("\n"); reject(new LoginError("Login cancelled")); return; }
        if (character === "\r" || character === "\n") { cleanup(); output.write("\n"); resolve(characters.join("")); return; }
        if (character === "\u007f" || character === "\b") characters.pop();
        else if (character >= " ") characters.push(character);
      }
    };
    const cleanup = () => { input.off("data", onData); input.setRawMode?.(false); input.pause(); };
    input.on("data", onData);
    input.resume();
    // Display the prompt only after echo is disabled and the input handler is ready.
    output.write(prompt);
  });
}

export async function runLogin(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new LoginError("Login requires an interactive terminal");
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const url = (await terminal.question("Jira URL: ")).trim();
    const user = (await terminal.question("Jira username: ")).trim();
    terminal.close();
    const password = await readHidden("Jira password (input hidden): ");
    if (!url || !user || !password) throw new LoginError("Jira URL, username, and password are required");
    const session = await authenticateSession(url, user, password);
    // Login is verified first so a typo never overwrites working settings.
    await saveCredentials({ url: session.url, username: user, password });
    stdout.write(`Jira credentials saved to ${path.join(homedir(), ".bluntjira", "settings.json")} (permissions 600). The server logs in automatically.\n`);
  } finally {
    terminal.close();
  }
}
