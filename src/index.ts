// linkedin-poster — post to your own LinkedIn feed from Claude Code or curl.
//
// Routes
//   GET  /                 liveness, no secrets
//   GET  /auth/start?key=  begin OAuth (guarded by SETUP_KEY)
//   GET  /auth/callback    OAuth redirect target, stores the token
//   GET  /status           token state (bearer)
//   POST /post             publish a text post (bearer)
//   POST /mcp              MCP server, streamable HTTP (bearer)
//   GET  /telegram/chatid  discover the group's chat id (guarded by SETUP_KEY)
//   GET  /telegram/test    send a test message (guarded by SETUP_KEY)
//   GET  /telegram/preview render any message without waiting for its event
//   cron                   daily summary, and the renewal alarm on top of it

import { authorizationUrl, createTextPost, exchangeCode, fetchUserInfo, LinkedInError, type Visibility } from "./linkedin";
import { errorsOf, formatFindings, lint } from "./lint";
import { handleMcpMessage } from "./mcp";
import { announceBlocked, announceNoToken, announcePosted, announceRejected, notify, type NotifyEvent, render } from "./notify";
import { bump, dayKey, readStats } from "./stats";
import { CHAT_ID_KEY, discoverChats, sendTelegram, telegramConfig } from "./telegram";
import {
  bearerFrom,
  clearRenewalNonce,
  daysLeft,
  isExpired,
  LAST_NOTIFIED_KEY,
  mintRenewalNonce,
  readToken,
  renewalNonceMatches,
  secretsMatch,
  writeToken,
} from "./tokens";

const STATE_PREFIX = "state:";
const STATE_TTL_SECONDS = 600;
/** Days remaining at which the summary is promoted to a renewal alarm. */
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

async function requireBearer(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const presented = bearerFrom(request);
  if (!presented || !(await secretsMatch(presented, env.API_TOKEN))) {
    // Counted, not announced. A single stray request is noise; a day's worth of
    // them shows up in the summary, which is where a pattern becomes visible.
    ctx.waitUntil(bump(env.TOKENS, "unauthorized"));
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

async function handleAuthStart(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Without this guard anyone who found the URL could bind *their* LinkedIn
  // account to this Worker, overwriting the stored token.
  //
  // Two ways in. `key` is the setup key, for a human at a keyboard. `t` is the
  // single-use nonce carried by the renewal link in a chat message, which
  // exists so that link can be tapped without the setup key ever entering a
  // chat log.
  const params = new URL(request.url).searchParams;
  const key = params.get("key") ?? "";
  const nonce = params.get("t") ?? "";
  const authorized = nonce
    ? await renewalNonceMatches(env.TOKENS, nonce)
    : await secretsMatch(key, env.SETUP_KEY);
  if (!authorized) {
    ctx.waitUntil(bump(env.TOKENS, "unauthorized"));
    return html("<h1>Not authorized</h1><p>Append <code>?key=</code> with the setup key.</p>", 403);
  }

  const state = crypto.randomUUID();
  await env.TOKENS.put(`${STATE_PREFIX}${state}`, "1", { expirationTtl: STATE_TTL_SECONDS });

  return Response.redirect(authorizationUrl(env.LINKEDIN_CLIENT_ID, env.REDIRECT_URI, state), 302);
}

async function handleAuthCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    // The outstanding renewal link has done its job; a message someone scrolls
    // back to next month should not still open an authorization flow.
    await clearRenewalNonce(env.TOKENS);

    const expires = new Date(now + token.expires_in * 1000).toISOString().slice(0, 10);
    console.log(JSON.stringify({ event: "token_stored", expires }));

    // Closes the loop on the reminder: the group saw the alarm, and now it sees
    // that the alarm was acted on and what the new deadline is.
    ctx.waitUntil(
      notify(env, {
        kind: "reconnected",
        name: user.name ?? user.sub,
        expiresAt: now + token.expires_in * 1000,
        days: Math.floor(token.expires_in / 86_400),
      }),
    );

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

async function handlePost(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    ctx.waitUntil(announceBlocked(env, findings, text, "http"));
    return json({ error: "lint failed", findings, hint: "pass force: true to publish anyway" }, 422);
  }

  const token = await readToken(env.TOKENS);
  if (!token || isExpired(token)) {
    ctx.waitUntil(announceNoToken(env, Boolean(token), "http"));
    return json({ error: token ? "token expired" : "no token stored", hint: "visit /auth/start?key=…" }, 503);
  }

  try {
    const result = await createTextPost(token, env.LINKEDIN_VERSION, text, visibility);
    console.log(JSON.stringify({ event: "posted", urn: result.urn, length: text.length }));
    ctx.waitUntil(announcePosted(env, result, text, visibility, "http", findings));
    return json({ ...result, visibility, warnings: findings.filter((f) => f.severity === "warning") }, 201);
  } catch (err) {
    if (err instanceof LinkedInError) {
      console.error(JSON.stringify({ event: "post_failed", status: err.status, body: err.body.slice(0, 500) }));
      ctx.waitUntil(announceRejected(env, err, "http"));
      return json({ error: "linkedin rejected the post", status: err.status, body: err.body.slice(0, 1000) }, 502);
    }
    throw err;
  }
}

async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      const response = await handleMcpMessage(message, env, ctx);
      if (response) responses.push(response);
    }
    return responses.length === 0 ? new Response(null, { status: 202 }) : json(responses);
  }

  const response = await handleMcpMessage(body as Parameters<typeof handleMcpMessage>[0], env, ctx);
  return response === null ? new Response(null, { status: 202 }) : json(response);
}

/**
 * Discovers the chat id of a freshly created group, so it never has to be read
 * off a phone or out of a local script. Equivalent to `npm run chatid` in the
 * sibling javna-nabava tool.
 */
async function handleTelegramChatId(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!(await secretsMatch(key, env.SETUP_KEY))) {
    ctx.waitUntil(bump(env.TOKENS, "unauthorized"));
    return json({ error: "unauthorized" }, 403);
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    return json({ error: "TELEGRAM_BOT_TOKEN is not set" }, 503);
  }

  const chats = await discoverChats(env.TELEGRAM_BOT_TOKEN);
  return json({
    chats,
    configured: env.TELEGRAM_CHAT_ID || null,
    adopted: await env.TOKENS.get(CHAT_ID_KEY),
    hint:
      chats.length === 0
        ? "No updates yet. A bot with privacy mode on only sees messages that mention it: send /start@yourbot in the group, then reload."
        : "Set the id you want with: wrangler secret put TELEGRAM_CHAT_ID",
  });
}

/**
 * Renders any message the service can send, without waiting for the event that
 * would produce it. `?kind=daily` is the useful one: it answers "what would the
 * summary say right now" on any day, not just at 09:00 UTC. Add `&send=1` to
 * put it in the group and see it on a phone, where it will actually be read.
 *
 * The daily preview uses the real token and the real counters. The rest are
 * samples, since the point is the wording.
 */
async function handleTelegramPreview(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (!(await secretsMatch(params.get("key") ?? "", env.SETUP_KEY))) {
    ctx.waitUntil(bump(env.TOKENS, "unauthorized"));
    return json({ error: "unauthorized" }, 403);
  }

  const kind = params.get("kind") ?? "daily";
  const sample = { url: "https://www.linkedin.com/feed/update/urn:li:share:0/", urn: "urn:li:share:0" };
  const sampleText = "A sample post body, long enough to show how an excerpt is trimmed in the message.";

  let event: NotifyEvent;
  switch (kind) {
    case "posted":
      event = { kind: "posted", ...sample, text: sampleText, visibility: "PUBLIC", source: "mcp", warnings: [] };
      break;
    case "lint_blocked":
      event = { kind: "lint_blocked", findings: errorsOf(lint("A draft with an em-dash — right here.")), text: sampleText, source: "mcp" };
      break;
    case "linkedin_rejected":
      event = { kind: "linkedin_rejected", status: 401, body: '{"message":"Invalid access token"}', source: "http" };
      break;
    case "no_token":
      event = { kind: "no_token", expired: true, source: "mcp" };
      break;
    case "reconnected":
      event = { kind: "reconnected", name: "Sample Member", expiresAt: Date.now() + 60 * 86_400_000, days: 60 };
      break;
    case "quota":
      event = { kind: "quota", stats: { ...(await readStats(env.TOKENS)), posted: 118, rejected: 4 } };
      break;
    case "daily": {
      const token = await readToken(env.TOKENS);
      const remaining = token ? Math.max(0, daysLeft(token)) : 0;
      event = {
        kind: "daily",
        day: dayKey(),
        stats: await readStats(env.TOKENS),
        token: token
          ? {
              name: token.name,
              expiresAt: token.expiresAt,
              daysLeft: remaining,
              expired: isExpired(token),
              // Forced on with ?renewal=1, to read the alarm on a day it is not due.
              renewalDue: params.get("renewal") === "1" || remaining <= Number(env.RENEW_WARNING_DAYS),
            }
          : null,
        // A preview never mints a nonce: that would silently kill the link in
        // the reminder already sitting in the group.
        renewLink: null,
      };
      break;
    }
    default:
      return json({ error: `unknown kind: ${kind}`, kinds: ["daily", "posted", "lint_blocked", "linkedin_rejected", "no_token", "reconnected", "quota"] }, 400);
  }

  const text = render(event);
  if (params.get("send") !== "1") {
    return json({ kind, sent: false, text });
  }

  const config = await telegramConfig(env);
  if (!config) return json({ error: "telegram not configured", kind, text }, 503);
  const sent = await sendTelegram(env, config, text);
  return json({ kind, sent, text }, sent ? 200 : 502);
}

/** Proves the whole path works, end to end, before anything depends on it. */
async function handleTelegramTest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!(await secretsMatch(key, env.SETUP_KEY))) {
    ctx.waitUntil(bump(env.TOKENS, "unauthorized"));
    return json({ error: "unauthorized" }, 403);
  }

  const config = await telegramConfig(env);
  if (!config) {
    return json({ error: "telegram not configured", need: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] }, 503);
  }

  const sent = await sendTelegram(
    env,
    config,
    "🧪 <b>linkedin-poster</b>\nTest message. If you can read this, the daily summary and the renewal alarm will arrive here too.",
  );
  return json({ sent, chatId: (await env.TOKENS.get(CHAT_ID_KEY)) ?? env.TELEGRAM_CHAT_ID }, sent ? 200 : 502);
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
        return await handleAuthStart(request, env, ctx);
      }
      if (request.method === "GET" && pathname === "/auth/callback") {
        return await handleAuthCallback(request, env, ctx);
      }

      if (request.method === "GET" && pathname === "/telegram/chatid") {
        return await handleTelegramChatId(request, env, ctx);
      }
      if (request.method === "GET" && pathname === "/telegram/test") {
        return await handleTelegramTest(request, env, ctx);
      }
      if (request.method === "GET" && pathname === "/telegram/preview") {
        return await handleTelegramPreview(request, env, ctx);
      }

      if (request.method === "GET" && pathname === "/status") {
        const denied = await requireBearer(request, env, ctx);
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
        const denied = await requireBearer(request, env, ctx);
        if (denied) return denied;
        return await handlePost(request, env, ctx);
      }

      if (request.method === "POST" && pathname === "/mcp") {
        const denied = await requireBearer(request, env, ctx);
        if (denied) return denied;
        return await handleMcp(request, env, ctx);
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

  /**
   * One message a day, every day.
   *
   * The summary is the heartbeat: it goes out on quiet days too, so its absence
   * is the signal that something broke, and no uptime monitor is needed to
   * notice. On the days a renewal is due the same message leads with the alarm
   * instead of sending a second one, which keeps the group's rhythm at exactly
   * one post per morning and never trains anyone to skim it.
   */
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // The cron fires once a day, but a retried invocation would otherwise
        // produce a second summary for the same day.
        const today = dayKey();
        if ((await env.TOKENS.get(LAST_NOTIFIED_KEY)) === today) return;
        await env.TOKENS.put(LAST_NOTIFIED_KEY, today, { expirationTtl: 172_800 });

        const token = await readToken(env.TOKENS);
        const stats = await readStats(env.TOKENS, today);

        if (!token) {
          console.warn(JSON.stringify({ event: "cron", note: "no token stored" }));
          await notify(env, { kind: "daily", day: today, stats, token: null, renewLink: null });
          return;
        }

        const expired = isExpired(token);
        const remaining = Math.max(0, daysLeft(token));
        const warnAt = Number(env.RENEW_WARNING_DAYS);
        const renewalDue = NOTIFY_AT_DAYS.has(remaining) || remaining <= warnAt || expired;

        // The link is only minted on the days it is offered, so there is no
        // live nonce sitting in KV during the seven weeks nobody needs one.
        let renewLink: string | null = null;
        if (renewalDue) {
          const nonce = await mintRenewalNonce(env.TOKENS);
          renewLink = `${new URL(env.REDIRECT_URI).origin}/auth/start?t=${nonce}`;
        }

        await notify(env, {
          kind: "daily",
          day: today,
          stats,
          token: { name: token.name, expiresAt: token.expiresAt, daysLeft: remaining, expired, renewalDue },
          renewLink,
        });
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
