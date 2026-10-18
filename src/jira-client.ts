import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { sessionCookieSchema } from "./cookie.js";

const nonEmptyString = z.string().refine((value) => value.trim().length > 0);

// URL parsing normalizes the path; keep Jira's context path when appending REST paths.
// Source: https://zod.dev/api#refine
const jiraUrl = nonEmptyString.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && !value.includes("?")
      && !value.includes("#");
  } catch {
    return false;
  }
}).transform((value) => new URL(value).href.replace(/\/+$/, ""));

const settingsSchema = z.object({
  JIRA_URL: jiraUrl,
  JIRA_COOKIE_NAME: sessionCookieSchema.shape.name,
  JIRA_COOKIE_VALUE: sessionCookieSchema.shape.value,
});

interface JiraClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type JiraErrorKind = "http" | "network" | "timeout" | "format" | "redirect" | "cancelled" | "cooldown";
const retryableStatuses = new Set([429, 502, 503, 504]);
const authCooldownMs = 5 * 60_000;

export class JiraRequestError extends Error {
  constructor(
    message: string,
    readonly kind: JiraErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JiraRequestError";
  }
}

const jiraErrorSchema = z.object({
  errorMessages: z.array(z.string()).optional(),
  errors: z.record(z.string(), z.string()).optional(),
});

export class JiraClient {
  readonly #config: JiraConfig;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #cookie: string;
  readonly #activeRequests = new Set<AbortController>();
  #closed = false;
  readonly #now: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  #authBlockedUntil = 0;
  #authStatus: number | undefined;

  constructor(config: JiraConfig, options: JiraClientOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.#cookie = `${config.cookieName}=${config.cookieValue}`;
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#activeRequests) controller.abort();
  }

  getProjects(): Promise<unknown> {
    return this.#request("/project");
  }

  getIssue(issueKey: string, fields?: string[]): Promise<unknown> {
    const query = fields === undefined ? "" : `?${new URLSearchParams({ fields: fields.join(",") })}`;
    return this.#request(`/issue/${encodeURIComponent(issueKey)}${query}`);
  }

  searchIssues(input: {
    jql: string;
    fields?: string[] | undefined;
    startAt: number;
    maxResults: number;
  }): Promise<unknown> {
    return this.#request("/search", { method: "POST", body: input });
  }

  createIssue(fields: Record<string, unknown>): Promise<unknown> {
    return this.#request("/issue", { method: "POST", body: { fields }, write: true });
  }

  updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<unknown> {
    return this.#request(`/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT", body: { fields }, write: true,
    });
  }

  getComments(issueKey: string, startAt: number, maxResults: number): Promise<unknown> {
    const query = new URLSearchParams({ startAt: String(startAt), maxResults: String(maxResults) });
    return this.#request(`/issue/${encodeURIComponent(issueKey)}/comment?${query}`);
  }

  addComment(issueKey: string, body: string): Promise<unknown> {
    return this.#request(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST", body: { body }, write: true,
    });
  }

  getTransitions(issueKey: string): Promise<unknown> {
    return this.#request(`/issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`);
  }

  transitionIssue(issueKey: string, transitionId: string, fields?: Record<string, unknown>): Promise<unknown> {
    return this.#request(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: { transition: { id: transitionId }, ...(fields === undefined ? {} : { fields }) },
      write: true,
    });
  }

  #safeText(value: string): string {
    // Redact before truncating: a partial credential must not survive the limit.
    const secrets = [
      this.#cookie,
      this.#config.cookieValue,
    ].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      value = value.replaceAll(secret, "[REDACTED]");
    }
    // Replace ASCII control characters only; preserve non-ASCII error text.
    return value.replace(/(?=\p{ASCII})\p{Cc}/gu, " ").slice(0, 4096);
  }

  #httpError(response: Response, text: string): JiraRequestError {
    let message = `Jira HTTP ${response.status}`;
    try {
      const parsed = jiraErrorSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        const details = [
          ...parsed.data.errorMessages ?? [],
          ...Object.entries(parsed.data.errors ?? {}).map(([key, value]) => `${key}: ${value}`),
        ];
        if (details.length > 0) message += `: ${details.join("; ")}`;
      }
    } catch {
      // HTML login pages and malformed JSON are never returned to the client.
    }
    const retryAfter = response.headers.get("Retry-After");
    if (retryableStatuses.has(response.status) && retryAfter) message += `; Retry-After: ${retryAfter}`;
    if (response.status === 401 || response.status === 403) {
      message += response.status === 401
        ? "; Jira session may have expired. Run `bluntjira login` and restart the MCP server."
        : "; Requests paused for 300 seconds. Check Jira permissions and CAPTCHA.";
    }
    return new JiraRequestError(this.#safeText(message), "http", response.status);
  }

  #assertAvailable(): void {
    if (this.#closed) throw new JiraRequestError("Jira client is closed", "cancelled");
    const remaining = this.#authBlockedUntil - this.#now();
    if (remaining > 0) {
      throw new JiraRequestError(
        `Jira requests paused for ${Math.ceil(remaining / 1000)} seconds after HTTP ${this.#authStatus}. Check credentials, permissions and CAPTCHA; no HTTP request was sent.`,
        "cooldown", this.#authStatus,
      );
    }
  }

  #retryDelay(attempt: number, response: Response): number {
    const backoff = 1000 * 2 ** attempt + Math.floor(Math.random() * 251);
    const value = response.headers.get("Retry-After");
    if (value === null) return backoff;
    const retryAfter = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - this.#now();
    return Number.isNaN(retryAfter) ? backoff : Math.max(backoff, retryAfter);
  }

  async #request(path: string, options: {
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    write?: boolean;
  } = {}): Promise<unknown> {
    this.#assertAvailable();
    const controller = new AbortController();
    this.#activeRequests.add(controller);
    const deadline = this.#now() + this.#timeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      for (let attempt = 0; ; attempt++) {
        this.#assertAvailable();
        controller.signal.throwIfAborted();
        const response = await this.#fetch(`${this.#config.url}/rest/api/2${path}`, {
          method: options.method ?? "GET",
          headers: {
            Accept: "application/json",
            Cookie: this.#cookie,
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          redirect: "manual",
          signal: controller.signal,
        });
        // Pause immediately on headers, even if reading the error body later fails.
        if (response.status === 401 || response.status === 403) {
          this.#authStatus = response.status;
          this.#authBlockedUntil = this.#now() + authCooldownMs;
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new JiraRequestError("Jira redirect refused; check JIRA_URL", "redirect", response.status);
        }
        // One timeout covers all attempts, response bodies and backoff waits.
        const text = await response.text();
        if (!response.ok) {
          const failure = this.#httpError(response, text);
          if (options.write || !retryableStatuses.has(response.status) || attempt >= 2) throw failure;
          const waitMs = this.#retryDelay(attempt, response);
          // Never retry earlier than Retry-After to fit our time budget.
          if (waitMs >= deadline - this.#now()) throw failure;
          await this.#wait(waitMs, controller.signal);
          continue;
        }
        if (text.trim() === "") return { success: true };
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new JiraRequestError("Jira returned an invalid JSON response", "format");
        }
      }
    } catch (error: unknown) {
      // Never attach a cause: transport errors may contain URLs or credentials.
      const failure = error instanceof JiraRequestError ? error
        : this.#closed ? new JiraRequestError("Jira request cancelled", "cancelled")
          : controller.signal.aborted ? new JiraRequestError("Jira request timed out", "timeout")
            : new JiraRequestError("Unable to reach Jira", "network");
      // POST is not sufficient to infer writes: JQL search is a read-only POST.
      if (options.write && (failure.kind === "network" || failure.kind === "timeout"
        || failure.kind === "format" || failure.kind === "cancelled" || (failure.status ?? 0) >= 500)) {
        throw new JiraRequestError(
          `${failure.message}. Write outcome is unknown; check Jira before retrying.`,
          failure.kind, failure.status,
        );
      }
      throw failure;
    } finally {
      this.#activeRequests.delete(controller);
      clearTimeout(timeout);
    }
  }
}

export interface JiraConfig {
  readonly url: string;
  readonly cookieName: string;
  readonly cookieValue: string;
}

/** Validate stored Jira settings; never include their values in errors. */
export function loadJiraConfig(settings: unknown): JiraConfig {
  const result = settingsSchema.safeParse(settings);
  if (!result.success) {
    // Raw Zod issues can include input values. Expose only known setting names.
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid Jira settings: ${names.join(", ")}. Run the login command again.`);
  }

  return {
    url: result.data.JIRA_URL,
    cookieName: result.data.JIRA_COOKIE_NAME,
    cookieValue: result.data.JIRA_COOKIE_VALUE,
  };
}
