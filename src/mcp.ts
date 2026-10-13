// Minimal MCP server over streamable HTTP.
//
// Hand-rolled JSON-RPC rather than the SDK: the surface is three tools and a
// handshake, and a dependency-free Worker deploys in a second and cannot drift
// out of step with a transport library.
//
// The server is stateless. Every POST carries a complete request, so there is
// no session to lose and Claude Code can reconnect at any point.

import { deleteDraft, getDraft, listDrafts } from "./drafts";
import { createTextPost, LinkedInError, type Visibility } from "./linkedin";
import { errorsOf, formatFindings, lint } from "./lint";
import { announceBlocked, announceNoToken, announcePosted, announceRejected } from "./notify";
import { daysLeft, isExpired, readToken } from "./tokens";

/** Falls back to this only when a client does not state its own revision. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "linkedin_post",
    description:
      "Publish a text post to the authenticated member's own LinkedIn feed. The text is linted first: em-dashes, en-dashes, an empty body, or text over 3000 characters block the post unless force is true. Bare URLs stay bare — LinkedIn's Posts API does not generate link previews.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post body, exactly as it should appear. Blank lines are the only structure LinkedIn renders." },
        visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS"], description: "Defaults to PUBLIC." },
        force: { type: "boolean", description: "Publish even when the linter reports errors. Use only on an explicit human instruction." },
      },
      required: ["text"],
    },
  },
  {
    name: "linkedin_check",
    description:
      "Lint post text without publishing it. Reports em-dashes and en-dashes as errors, and markdown that LinkedIn would render literally as warnings. Use this while drafting.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "linkedin_drafts",
    description:
      "List the episode drafts waiting for review. The nightly domovina.ai pipeline writes one per new episode and parks it here instead of publishing it. Returns each draft's id, channel and title.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "linkedin_draft",
    description:
      "Read one parked draft in full: the post body as written, the episode it came from, and its link. Use this before publishing so the text can be edited first.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The draft id, which is the episode's YouTube id." } },
      required: ["id"],
    },
  },
  {
    name: "linkedin_publish_draft",
    description:
      "Publish a parked draft to the member's own feed. Pass text to publish an edited version instead of the stored one; the stored draft is dropped either way once LinkedIn accepts the post. Same linter as linkedin_post.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The draft id, which is the episode's YouTube id." },
        text: { type: "string", description: "Replacement body. Omit to publish the draft exactly as stored." },
        visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS"], description: "Defaults to PUBLIC." },
        force: { type: "boolean", description: "Publish even when the linter reports errors." },
      },
      required: ["id"],
    },
  },
  {
    name: "linkedin_discard_draft",
    description:
      "Drop a parked draft without publishing it. Drafts also expire on their own after 14 days, so this is only for clearing the list early.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "linkedin_status",
    description:
      "Report whether the service holds a valid LinkedIn token, who it belongs to, and how many days remain before it expires. LinkedIn access tokens last 60 days and cannot be refreshed programmatically by self-serve apps.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<ReturnType<typeof textResult>> {
  if (name === "linkedin_check") {
    const text = typeof args.text === "string" ? args.text : "";
    const findings = lint(text);
    const header = `${text.length} characters. ${errorsOf(findings).length} error(s), ${findings.length - errorsOf(findings).length} warning(s).`;
    return textResult(`${header}\n\n${formatFindings(findings)}`);
  }

  if (name === "linkedin_status") {
    const token = await readToken(env.TOKENS);
    if (!token) {
      return textResult("No LinkedIn token stored. Visit /auth/start?key=<SETUP_KEY> to connect an account.", true);
    }
    if (isExpired(token)) {
      return textResult(
        `Token EXPIRED on ${new Date(token.expiresAt).toISOString().slice(0, 10)}. Re-authorize at /auth/start?key=<SETUP_KEY>.`,
        true,
      );
    }
    const remaining = daysLeft(token);
    return textResult(
      [
        `Connected as ${token.name ?? token.personUrn}`,
        `Author URN: ${token.personUrn}`,
        `Expires: ${new Date(token.expiresAt).toISOString().slice(0, 10)} (${remaining} days left)`,
        remaining <= Number(env.RENEW_WARNING_DAYS)
          ? "Renew now — silent renewal only works while the current token is still valid."
          : "No action needed.",
      ].join("\n"),
    );
  }

  if (name === "linkedin_drafts") {
    const drafts = await listDrafts(env.TOKENS);
    if (drafts.length === 0) {
      return textResult("No drafts waiting. The nightly pipeline parks one here for every new episode on domovina.ai.");
    }
    const lines = drafts.map(
      (draft) =>
        `${draft.id}  ${draft.channel} · ${draft.title} (${draft.chars} chars, ${new Date(draft.createdAt).toISOString().slice(0, 10)})`,
    );
    return textResult(`${drafts.length} draft(s) waiting:\n\n${lines.join("\n")}`);
  }

  if (name === "linkedin_draft") {
    const draft = await getDraft(env.TOKENS, typeof args.id === "string" ? args.id : "");
    if (!draft) return textResult(`No draft with id ${String(args.id)}. Run linkedin_drafts to see what is waiting.`, true);
    const findings = lint(draft.text);
    return textResult(
      [
        `${draft.channel} · ${draft.title}`,
        `Episode: ${draft.url}`,
        `Drafted: ${new Date(draft.createdAt).toISOString()}${draft.model ? ` by ${draft.model}` : ""}`,
        `${draft.text.length} characters, ${errorsOf(findings).length} lint error(s)`,
        "",
        draft.text,
      ].join("\n"),
    );
  }

  if (name === "linkedin_discard_draft") {
    const id = typeof args.id === "string" ? args.id : "";
    const draft = await getDraft(env.TOKENS, id);
    if (!draft) return textResult(`No draft with id ${id}.`, true);
    await deleteDraft(env.TOKENS, id);
    return textResult(`Discarded the draft for ${draft.title}.`);
  }

  // Publishing a draft is the normal publish path with the stored text loaded
  // first, so it cannot drift away from linkedin_post: same lint, same token
  // check, same announcement. The draft is dropped only once LinkedIn accepts
  // the post, which keeps a rejection recoverable.
  if (name === "linkedin_publish_draft") {
    const id = typeof args.id === "string" ? args.id : "";
    const draft = await getDraft(env.TOKENS, id);
    if (!draft) return textResult(`No draft with id ${id}. Run linkedin_drafts to see what is waiting.`, true);

    const replacement = typeof args.text === "string" && args.text.trim() ? args.text : draft.text;
    const result = await callTool(
      "linkedin_post",
      { text: replacement, visibility: args.visibility, force: args.force },
      env,
      ctx,
    );
    if (!result.isError) await deleteDraft(env.TOKENS, id);
    return result;
  }

  if (name === "linkedin_post") {
    const text = typeof args.text === "string" ? args.text : "";
    const force = args.force === true;
    const visibility: Visibility = args.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC";

    const findings = lint(text);
    const errors = errorsOf(findings);
    if (errors.length > 0 && !force) {
      ctx.waitUntil(announceBlocked(env, findings, text, "mcp"));
      return textResult(
        `Not published. Fix these first, or pass force: true to override.\n\n${formatFindings(findings)}`,
        true,
      );
    }

    const token = await readToken(env.TOKENS);
    if (!token || isExpired(token)) {
      ctx.waitUntil(announceNoToken(env, Boolean(token), "mcp"));
      return textResult(
        token
          ? "LinkedIn token has expired. Re-authorize at /auth/start?key=<SETUP_KEY>."
          : "No LinkedIn token stored. Visit /auth/start?key=<SETUP_KEY> first.",
        true,
      );
    }

    try {
      const result = await createTextPost(token, env.LINKEDIN_VERSION, text, visibility);
      ctx.waitUntil(announcePosted(env, result, text, visibility, "mcp", findings));
      const warnings = findings.filter((f) => f.severity === "warning");
      const note = warnings.length > 0 ? `\n\nPublished with warnings:\n${formatFindings(warnings)}` : "";
      return textResult(`Published (${visibility}).\n${result.url || result.urn}${note}`);
    } catch (error) {
      if (error instanceof LinkedInError) {
        console.error(JSON.stringify({ event: "post_failed", status: error.status, body: error.body.slice(0, 500) }));
        ctx.waitUntil(announceRejected(env, error, "mcp"));
        return textResult(`LinkedIn rejected the post (${error.status}): ${error.body.slice(0, 500)}`, true);
      }
      throw error;
    }
  }

  return textResult(`Unknown tool: ${name}`, true);
}

/**
 * Handles one JSON-RPC message. Returns null for notifications, which carry no
 * id and must not be answered with a body.
 */
export async function handleMcpMessage(
  message: JsonRpcRequest,
  env: Env,
  ctx: ExecutionContext,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;

  switch (message.method) {
    case "initialize": {
      // Echo the client's revision when it states one. Guessing a version here
      // is how a working server starts failing after a spec bump.
      const requested = message.params?.protocolVersion;
      return ok(id, {
        protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "linkedin-poster", version: "1.0.0" },
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const name = message.params?.name;
      if (typeof name !== "string") return fail(id, -32602, "Missing tool name");
      const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        return ok(id, await callTool(name, args, env, ctx));
      } catch (error) {
        console.error(JSON.stringify({ event: "tool_error", tool: name, message: String(error) }));
        return fail(id, -32603, `Tool failed: ${String(error)}`);
      }
    }

    default:
      return fail(id, -32601, `Method not found: ${message.method}`);
  }
}
