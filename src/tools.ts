import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { JiraRequestError, type JiraClient } from "./jira-client.js";

const nonEmptyString = z.string().refine((value) => value.trim().length > 0);
// Dot segments are not Jira identifiers and must not normalize into a different REST path.
const identifier = nonEmptyString.refine((value) => value !== "." && value !== "..");
const fieldNames = z.array(nonEmptyString).optional();
const pagination = {
  startAt: z.number().int().min(0).default(0),
  maxResults: z.number().int().min(1).max(100).default(50),
};
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const jsonFields = z.record(z.string(), z.json());
const createFields = z.object({
  project: z.object({ key: identifier.optional(), id: identifier.optional() }).catchall(z.json())
    .refine((value) => value.key !== undefined || value.id !== undefined, "Project key or id is required"),
  summary: nonEmptyString,
  issuetype: z.object({ id: identifier.optional(), name: nonEmptyString.optional() }).catchall(z.json())
    .refine((value) => value.id !== undefined || value.name !== undefined, "Issue type id or name is required"),
}).catchall(z.json());
const updateFields = jsonFields
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .refine((value) => !Object.hasOwn(value, "status"), "Use transition_issue to change status");

async function toolResult(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await operation();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error: unknown) {
    const message = error instanceof JiraRequestError ? error.message : "Jira request failed";
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

// Contracts: https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md
// Jira REST v2: https://docs.atlassian.com/software/jira/docs/api/REST/9.12.0/
export function registerTools(server: McpServer, jira: JiraClient): void {
  server.registerTool("get_projects", {
    description: "List Jira projects visible to the configured user.",
    inputSchema: z.strictObject({}),
    annotations: readAnnotations,
  }, () => toolResult(() => jira.getProjects()));

  server.registerTool("get_issue", {
    description: "Read a Jira issue by key or numeric ID, optionally selecting fields.",
    inputSchema: z.strictObject({ issueKey: identifier, fields: fieldNames }),
    annotations: readAnnotations,
  }, ({ issueKey, fields }) => toolResult(() => jira.getIssue(issueKey, fields)));

  server.registerTool("search_issues", {
    description: "Search Jira with JQL. Returns one page and Jira pagination metadata; no automatic page traversal.",
    inputSchema: z.strictObject({ jql: nonEmptyString, fields: fieldNames, ...pagination }),
    annotations: readAnnotations,
  }, (input) => toolResult(() => jira.searchIssues(input)));

  server.registerTool("create_issue", {
    description: "Create a Jira issue using fields: project (key or id), summary, issuetype (id or name), plus custom fields required by the project. Writes to Jira; do not blindly retry an unknown outcome.",
    inputSchema: z.strictObject({ fields: createFields }),
    annotations: writeAnnotations,
  }, ({ fields }) => toolResult(() => jira.createIssue(fields)));

  server.registerTool("update_issue", {
    description: "Update issue fields, preserving custom fields and null values. Use transition_issue for status changes. Writes to Jira.",
    inputSchema: z.strictObject({ issueKey: identifier, fields: updateFields }),
    annotations: writeAnnotations,
  }, ({ issueKey, fields }) => toolResult(() => jira.updateIssue(issueKey, fields)));

  server.registerTool("get_comments", {
    description: "Read one page of issue comments with Jira pagination metadata. Text is returned unchanged.",
    inputSchema: z.strictObject({ issueKey: identifier, ...pagination }),
    annotations: readAnnotations,
  }, ({ issueKey, startAt, maxResults }) => toolResult(() => jira.getComments(issueKey, startAt, maxResults)));

  server.registerTool("add_comment", {
    description: "Add a comment as a REST API v2 text string (Jira wiki markup, not ADF). Writes to Jira.",
    inputSchema: z.strictObject({ issueKey: identifier, body: nonEmptyString }),
    annotations: writeAnnotations,
  }, ({ issueKey, body }) => toolResult(() => jira.addComment(issueKey, body)));

  server.registerTool("get_transitions", {
    description: "List transitions available to the current user, including required transition field metadata.",
    inputSchema: z.strictObject({ issueKey: identifier }),
    annotations: readAnnotations,
  }, ({ issueKey }) => toolResult(() => jira.getTransitions(issueKey)));

  server.registerTool("transition_issue", {
    description: "Change status using a transitionId from get_transitions. Include fields required by the transition screen. Writes to Jira; never directly updates status.",
    inputSchema: z.strictObject({ issueKey: identifier, transitionId: identifier, fields: jsonFields.optional() }),
    annotations: writeAnnotations,
  }, ({ issueKey, transitionId, fields }) => toolResult(() => jira.transitionIssue(issueKey, transitionId, fields)));
}
