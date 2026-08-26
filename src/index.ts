// linkedin-poster — post to your own LinkedIn feed from Claude Code or curl.
//
// Routes
//   GET  /                 liveness, no secrets
//   GET  /auth/start?key=  begin OAuth (guarded by SETUP_KEY)
//   GET  /auth/callback    OAuth redirect target, stores the token
//   GET  /status           token state (bearer)
//   POST /post             publish a text post (bearer)
//   POST /mcp              MCP server, streamable HTTP (bearer)
//   cron                   renewal reminder while silent renewal still works

import { authorizationUrl, createTextPost, exchangeCode, fetchUserInfo, LinkedInError, type Visibility } from "./linkedin";
import { errorsOf, formatFindings, lint } from "./lint";
import { handleMcpMessage } from "./mcp";
import { bearerFrom, daysLeft, isExpired, LAST_NOTIFIED_KEY, readToken, secretsMatch, writeToken } from "./tokens";

const STATE_PREFIX = "state:";
const STATE_TTL_SECONDS = 600;
/** Days remaining at which a reminder goes out. */
const NOTIFY_AT_DAYS = new Set([14, 7, 3, 1, 0]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>linkedin-poster</title>
<style>body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a;background:#fff}
code{font-family:ui-monospace,monospace;background:#f4f4f5;padding:.15em .4em;border-radius:.25rem}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222}}</style>
${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function requireBearer(request: Request, env: Env): Promise<Response | null> {
  const presented = bearerFrom(request);
  if (!presented || !(await secretsMatch(presented, env.API_TOKEN))) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

async function handleAuthStart(request: Request, env: Env): Promise<Response> {
  // Without this guard anyone who found the URL could bind *their* LinkedIn
  // account to this Worker, overwriting the stored token.
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!(await secretsMatch(key, env.SETUP_KEY))) {
    return html("<h1>Not authorized</h1><p>Append <code>?key=</code> with the setup key.</p>", 403);
  }

  const state = crypto.randomUUID();
  await env.TOKENS.put(`${STATE_PREFIX}${state}`, "1", { expirationTtl: STATE_TTL_SECONDS });

  return Response.redirect(authorizationUrl(env.LINKEDIN_CLIENT_ID, env.REDIRECT_URI, state), 302);
}

async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const error = params.get("error");
  if (error) {
    return html(`<h1>Authorization declined</h1><p><code>${error}</code>: ${params.get("error_description") ?? ""}</p>`, 400);
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return html("<h1>Missing code or state</h1>", 400);
  }

  // State must have been minted by /auth/start and is single-use.
  const stateKey = `${STATE_PREFIX}${state}`;
  if ((await env.TOKENS.get(stateKey)) === null) {
    return html("<h1>Invalid or expired state</h1><p>Start again at <code>/auth/start</code>.</p>", 400);
  }
  await env.TOKENS.delete(stateKey);

  try {
    const token = await exchangeCode(code, env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET, env.REDIRECT_URI);
    const user = await fetchUserInfo(token.access_token);
    const now = Date.now();

    await writeToken(env.TOKENS, {
      accessToken: token.access_token,
      obtainedAt: now,
      expiresAt: now + token.expires_in * 1000,
      personUrn: `urn:li:person:${user.sub}`,
      name: user.name,
      scope: token.scope,
    });
    await env.TOKENS.delete(LAST_NOTIFIED_KEY);

    const expires = new Date(now + token.expires_in * 1000).toISOString().slice(0, 10);
    console.log(JSON.stringify({ event: "token_stored", expires }));

    return html(
      `<h1>Connected</h1><p>Posting as <strong>${user.name ?? user.sub}</strong>.</p>
<p>This token expires on <strong>${expires}</strong>, in ${Math.floor(token.expires_in / 86400)} days.
LinkedIn does not issue refresh tokens to self-serve apps, so you will get a reminder to open this link again.</p>`,
    );
  } catch (err) {
    if (err instanceof LinkedInError) {
      console.error(JSON.stringify({ event: "auth_failed", status: err.status, body: err.body.slice(0, 500) }));
      return html(`<h1>Token exchange failed (${err.status})</h1><pre><code>${err.body.slice(0, 500)}</code></pre>`, 502);
    }
    throw err;
  }
}

async function handlePost(request: Request, env: Env): Promise<Response> {
  let payload: { text?: unknown; visibility?: unknown; force?: unknown; dry_run?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const text = typeof payload.text === "string" ? payload.text : "";
  const visibility: Visibility = payload.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC";
  const findings = lint(text);
  const errors = errorsOf(findings);

  if (payload.dry_run === true) {
    return json({ dryRun: true, length: text.length, findings });
  }
  if (errors.length > 0 && payload.force !== true) {
    return json({ error: "lint failed", findings, hint: "pass force: true to publish anyway" }, 422);
  }

  const token = await readToken(env.TOKENS);
  if (!token) return json({ error: "no token stored", hint: "visit /auth/start?key=…" }, 503);
  if (isExpired(token)) return json({ error: "token expired", hint: "visit /auth/start?key=…" }, 503);

  try {
    const result = await createTextPost(token, env.LINKEDIN_VERSION, text, visibility);
    console.log(JSON.stringify({ event: "posted", urn: result.urn, length: text.length }));
    return json({ ...result, visibility, warnings: findings.filter((f) => f.severity === "warning") }, 201);
  } catch (err) {
    if (err instanceof LinkedInError) {
      console.error(JSON.stringify({ event: "post_failed", status: err.status, body: err.body.slice(0, 500) }));
      return json({ error: "linkedin rejected the post", status: err.status, body: err.body.slice(0, 1000) }, 502);
    }
    throw err;
  }
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  // A batch is a JSON array; a single call is an object.
  if (Array.isArray(body)) {
    const responses = [];
    for (const message of body) {
      const response = await handleMcpMessage(message, env);
      if (response) responses.push(response);
    }
    return responses.length === 0 ? new Response(null, { status: 202 }) : json(responses);
  }

  const response = await handleMcpMessage(body as Parameters<typeof handleMcpMessage>[0], env);
  return response === null ? new Response(null, { status: 202 }) : json(response);
}

async function notifyRenewal(env: Env, message: string): Promise<void> {
  if (!env.NOTIFY_WEBHOOK) {
    console.warn(JSON.stringify({ event: "renewal_due", message, note: "NOTIFY_WEBHOOK unset" }));
    return;
  }
  const response = await fetch(env.NOTIFY_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message, content: message }),
  });
  console.log(JSON.stringify({ event: "renewal_notified", status: response.status }));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === "GET" && pathname === "/") {
        return json({ service: "linkedin-poster", ok: true });
      }
      if (request.method === "GET" && pathname === "/auth/start") {
        return await handleAuthStart(request, env);
      }
      if (request.method === "GET" && pathname === "/auth/callback") {
        return await handleAuthCallback(request, env);
      }

      if (request.method === "GET" && pathname === "/status") {
        const denied = await requireBearer(request, env);
        if (denied) return denied;
        const token = await readToken(env.TOKENS);
        if (!token) return json({ connected: false }, 503);
        return json({
          connected: !isExpired(token),
          name: token.name,
          personUrn: token.personUrn,
          scope: token.scope,
          expiresAt: new Date(token.expiresAt).toISOString(),
          daysLeft: daysLeft(token),
        });
      }

      if (request.method === "POST" && pathname === "/post") {
        const denied = await requireBearer(request, env);
        if (denied) return denied;
        return await handlePost(request, env);
      }

      if (request.method === "POST" && pathname === "/mcp") {
        const denied = await requireBearer(request, env);
        if (denied) return denied;
        return await handleMcp(request, env);
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      // Explicit handling rather than passThroughOnException, which would hide
      // the failure and return a Cloudflare error page instead of a reason.
      console.error(JSON.stringify({ event: "unhandled", path: pathname, message: String(error) }));
      return json({ error: "internal error" }, 500);
    } finally {
      ctx.waitUntil(Promise.resolve());
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const token = await readToken(env.TOKENS);
        if (!token) {
          console.warn(JSON.stringify({ event: "cron", note: "no token stored" }));
          return;
        }

        const remaining = Math.max(0, daysLeft(token));
        const warnAt = Number(env.RENEW_WARNING_DAYS);
        const shouldNotify = NOTIFY_AT_DAYS.has(remaining) || remaining === warnAt || isExpired(token);
        if (!shouldNotify) return;

        // The cron runs daily; without this the last two weeks would produce a
        // reminder every single morning.
        const today = new Date().toISOString().slice(0, 10);
        if ((await env.TOKENS.get(LAST_NOTIFIED_KEY)) === today) return;
        await env.TOKENS.put(LAST_NOTIFIED_KEY, today, { expirationTtl: 172_800 });

        const message = isExpired(token)
          ? "LinkedIn token has EXPIRED. Re-authorize at /auth/start?key=… — you will see the consent screen this time."
          : `LinkedIn token expires in ${remaining} day(s). Open /auth/start?key=… now: while the current token is still valid the consent screen is skipped and it is a single redirect.`;

        await notifyRenewal(env, message);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
