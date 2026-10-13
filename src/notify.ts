// What the group hears about, and in what words.
//
// Three delivery paths, tried in order: the Telegram group, then the generic
// NOTIFY_WEBHOOK that predates it, then the log. A service with no chat
// configured keeps working exactly as it did before.
//
// Two rules hold this layer together:
//
//   1. Every failure that stops a post from reaching the feed produces a
//      message. The point of the group is that a broken service says so,
//      rather than waiting to be noticed on the day a post silently fails.
//   2. The daily summary goes out every single run, quiet day included, so its
//      absence is itself the alarm. Nothing here monitors the monitor.

import type { DraftSummary, EpisodeDraft } from "./drafts";
import type { LinkedInError } from "./linkedin";
import { errorsOf, type Finding } from "./lint";
import { bump, DAILY_POST_QUOTA, type DayStats, isQuiet, markQuotaWarned, QUOTA_WARN_AT, quotaUsed } from "./stats";
import { esc, sendTelegram, telegramConfig } from "./telegram";

/** Where a publish attempt came from, so a surprise post can be traced. */
export type Source = "mcp" | "http";

const SOURCE_LABEL: Record<Source, string> = { mcp: "MCP", http: "HTTP" };

/** How much of a post body a message quotes. */
const EXCERPT_LENGTH = 280;

export type NotifyEvent =
  | { kind: "posted"; url: string; urn: string; text: string; visibility: string; source: Source; warnings: Finding[] }
  | { kind: "lint_blocked"; findings: Finding[]; text: string; source: Source; forced?: boolean }
  | { kind: "linkedin_rejected"; status: number; body: string; source: Source }
  | { kind: "no_token"; expired: boolean; source: Source }
  | { kind: "reconnected"; name: string; expiresAt: number; days: number }
  | { kind: "quota"; stats: DayStats }
  | { kind: "draft"; draft: EpisodeDraft; findings: Finding[] }
  | { kind: "draft_link"; draft: EpisodeDraft }
  | {
      kind: "daily";
      day: string;
      stats: DayStats;
      token: DailyToken | null;
      renewLink: string | null;
      drafts: DraftSummary[];
    };

export interface DailyToken {
  name?: string;
  expiresAt: number;
  daysLeft: number;
  expired: boolean;
  /** True on the days a reminder is due, which promotes it to the headline. */
  renewalDue: boolean;
}

/** One line of post body, short enough to recognise and never long enough to flood. */
export function excerpt(text: string, limit = EXCERPT_LENGTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function isoDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function findingLines(findings: Finding[]): string {
  return findings
    .map((finding) => {
      const detail = finding.excerpt ? `\n   <code>${esc(finding.excerpt)}</code>` : "";
      return `• <b>${esc(finding.rule)}</b>: ${esc(finding.message)}${detail}`;
    })
    .join("\n");
}

/**
 * Turns a LinkedIn rejection into a sentence worth reading on a phone.
 *
 * The status alone is not actionable, and the raw body is a wall of JSON. These
 * four cover every rejection this service has a way to cause.
 */
function rejectionHint(status: number, body: string): string {
  if (status === 401) return "The token is dead or its scopes changed. Re-authorize.";
  if (status === 403) return "Permission refused. Check that <code>w_member_social</code> is still granted.";
  if (status === 429) return `Rate limited. LinkedIn allows ${DAILY_POST_QUOTA} requests per member per day.`;
  if (status === 426 || /version/i.test(body)) {
    return "This smells like a sunset <code>LinkedIn-Version</code>. Bump <code>LINKEDIN_VERSION</code> in wrangler.jsonc.";
  }
  return "Unmapped rejection. The body above is what LinkedIn said.";
}

function renderPosted(event: Extract<NotifyEvent, { kind: "posted" }>): string {
  const warnings = event.warnings.length
    ? `\n\n⚠️ Published with warnings: <i>${esc(event.warnings.map((w) => w.rule).join(", "))}</i>`
    : "";
  const link = event.url ? `\n\n🔗 <a href="${esc(event.url)}">Open the post</a>` : `\n\n<code>${esc(event.urn)}</code>`;
  return (
    `✅ <b>Posted to LinkedIn</b> · ${esc(event.visibility)} · via ${SOURCE_LABEL[event.source]}\n\n` +
    `<i>${esc(excerpt(event.text))}</i>${link}${warnings}`
  );
}

function renderLintBlocked(event: Extract<NotifyEvent, { kind: "lint_blocked" }>): string {
  return (
    `🛑 <b>Blocked by the linter</b> · via ${SOURCE_LABEL[event.source]}\n` +
    `Nothing was published.\n\n` +
    `${findingLines(event.findings)}\n\n` +
    `<i>${esc(excerpt(event.text, 160))}</i>`
  );
}

function renderRejected(event: Extract<NotifyEvent, { kind: "linkedin_rejected" }>): string {
  return (
    `❌ <b>LinkedIn rejected the post</b> · ${event.status} · via ${SOURCE_LABEL[event.source]}\n\n` +
    `<code>${esc(event.body.slice(0, 600))}</code>\n\n` +
    `💡 ${rejectionHint(event.status, event.body)}`
  );
}

function renderNoToken(event: Extract<NotifyEvent, { kind: "no_token" }>): string {
  const reason = event.expired ? "the stored token has expired" : "no token is stored";
  return (
    `🚫 <b>Publish attempt with no usable token</b> · via ${SOURCE_LABEL[event.source]}\n\n` +
    `The post did not go out because ${reason}. Re-authorize, and note that an expired ` +
    `token means the consent screen is back: two clicks instead of one.`
  );
}

function renderReconnected(event: Extract<NotifyEvent, { kind: "reconnected" }>): string {
  return (
    `🔓 <b>LinkedIn reconnected</b>\n\n` +
    `Posting as <b>${esc(event.name)}</b>.\n` +
    `Valid until <b>${isoDay(event.expiresAt)}</b>, ${event.days} days from now.\n\n` +
    `Renewal is a single tap again as long as you do it before that date.`
  );
}

function renderQuota(event: Extract<NotifyEvent, { kind: "quota" }>): string {
  const used = quotaUsed(event.stats);
  return (
    `📊 <b>Daily LinkedIn quota</b>\n\n` +
    `${used} of ${DAILY_POST_QUOTA} requests used today. The limit is per member, not per app, ` +
    `and failed attempts count too. Further posts today may be refused.`
  );
}

/**
 * A draft the nightly pipeline wrote for a new episode.
 *
 * The body goes out in a <pre> block rather than quoted or trimmed: this is the
 * one message whose whole purpose is to be read in full and copied, and
 * Telegram gives a pre block a copy button on the phone. The lint verdict rides
 * along because a draft that would be refused at publish time should say so
 * here, not eight hours later when somebody tries to send it.
 */
function renderDraft(event: Extract<NotifyEvent, { kind: "draft" }>): string {
  const { draft, findings } = event;
  const errors = errorsOf(findings);
  const warnings = findings.filter((finding) => finding.severity === "warning");

  const verdict = errors.length
    ? `🛑 linter: ${errors.map((finding) => finding.rule).join(", ")}. Fix before publishing.`
    : warnings.length
      ? `⚠️ linter: ${warnings.map((finding) => finding.rule).join(", ")}`
      : `✅ linter clean`;

  return (
    `📝 <b>Draft ready</b> · ${esc(draft.channel)}\n` +
    `<i>${esc(draft.title)}</i>\n\n` +
    `<pre>${esc(draft.text)}</pre>\n` +
    `🔗 ${esc(draft.url)}\n` +
    `🆔 <code>${esc(draft.id)}</code> · ${draft.text.length} characters · ${verdict}\n\n` +
    `Publish it from Claude Code: <code>linkedin_publish_draft</code> with this id. ` +
    `Untouched, it expires in 14 days.`
  );
}

/**
 * The card, on its own.
 *
 * Deliberately a second message rather than a preview hung under the draft. The
 * draft message exists to be copied, and on a phone a tap on its pre block is
 * the copy gesture; a large Open Graph card in the same bubble pushes the text
 * up and muddles what is being copied. Two messages keep each one doing one
 * job: the words here, the picture there.
 */
function renderDraftLink(event: Extract<NotifyEvent, { kind: "draft_link" }>): string {
  return `🖼 <b>How the link resolves</b>\n${esc(event.draft.url)}`;
}

/**
 * The heartbeat.
 *
 * On days a renewal reminder is due it leads with the alarm and carries the
 * summary underneath, so the group gets exactly one message a day and the most
 * urgent thing is always the first line.
 */
function renderDaily(event: Extract<NotifyEvent, { kind: "daily" }>): string {
  const { stats, token, renewLink, day, drafts } = event;

  let head = `🧾 <b>Daily summary</b> · ${esc(day)}`;
  if (token?.renewalDue || token?.expired) {
    const headline = token.expired
      ? `🚨 <b>The LinkedIn token has EXPIRED</b>`
      : `🚨 <b>Renew the LinkedIn token: ${token.daysLeft} day(s) left</b>`;
    const why = token.expired
      ? `Posting is down until it is renewed, and the consent screen is back, so this is two clicks now.`
      : `While the current token is still valid the consent screen is skipped, so this is one tap. After <b>${isoDay(token.expiresAt)}</b> it is two.`;
    const action = renewLink
      ? `\n\n👉 <a href="${esc(renewLink)}">Renew now</a>  <i>(single use, expires in 7 days)</i>`
      : `\n\n👉 Open <code>/auth/start?key=…</code> with the setup key.`;
    head = `${headline}\n\n${why}${action}\n\n———\n\n${head}`;
  }

  const tokenLine = token
    ? token.expired
      ? `🔑 Token: <b>expired</b> on ${isoDay(token.expiresAt)}`
      : `🔑 Token: ${token.daysLeft} days left, until ${isoDay(token.expiresAt)}`
    : `🔑 Token: <b>none stored</b>. Nothing can be published.`;

  const counters =
    `📮 posted ${stats.posted} · drafted ${stats.drafted} · blocked ${stats.blocked} · rejected ${stats.rejected}` +
    (stats.noToken ? ` · no token ${stats.noToken}` : "") +
    (stats.unauthorized ? ` · turned away ${stats.unauthorized}` : "");

  let body: string;
  if (isQuiet(stats)) {
    body = `📭 Quiet day. Nothing published, nothing refused, nobody knocking.`;
  } else if (stats.posts.length) {
    const listed = stats.posts
      .map((post) => (post.url ? `• <a href="${esc(post.url)}">${esc(post.excerpt)}</a>` : `• ${esc(post.excerpt)}`))
      .join("\n");
    body = `<b>Published today:</b>\n${listed}`;
  } else {
    body = `Nothing reached the feed today.`;
  }

  // Drafts do not expire quietly. A pile of them in the morning message is the
  // reminder that the pipeline wrote posts nobody has looked at yet.
  const waiting = drafts.length
    ? `\n\n📝 <b>Drafts waiting (${drafts.length}):</b>\n` +
      drafts
        .map((draft) => `• <code>${esc(draft.id)}</code> ${esc(excerpt(draft.title, 70))}`)
        .join("\n")
    : "";

  return `${head}\n${tokenLine}\n${counters}\n\n${body}${waiting}`;
}

export function render(event: NotifyEvent): string {
  switch (event.kind) {
    case "posted":
      return renderPosted(event);
    case "lint_blocked":
      return renderLintBlocked(event);
    case "linkedin_rejected":
      return renderRejected(event);
    case "no_token":
      return renderNoToken(event);
    case "reconnected":
      return renderReconnected(event);
    case "quota":
      return renderQuota(event);
    case "draft":
      return renderDraft(event);
    case "draft_link":
      return renderDraftLink(event);
    case "daily":
      return renderDaily(event);
  }
}

/** HTML is for Telegram; anything else gets the same words as plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/g, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Delivers one event. Never throws: a notification that fails must not take
 * down the request that produced it, and the log keeps the words either way.
 */
export async function notify(env: Env, event: NotifyEvent): Promise<void> {
  const html = render(event);
  // One message asks for a link preview: the follow-up that exists to show how
  // the episode page's Open Graph tags resolve. Everything else, the renewal
  // link above all, must never be prefetched by Telegram.
  const previewUrl = event.kind === "draft_link" ? event.draft.url : undefined;
  try {
    const config = await telegramConfig(env);
    if (config) {
      const sent = await sendTelegram(env, config, html, { previewUrl });
      if (sent) {
        console.log(JSON.stringify({ event: "notified", kind: event.kind, via: "telegram" }));
        return;
      }
    }

    const text = stripHtml(html);
    if (env.NOTIFY_WEBHOOK) {
      const response = await fetch(env.NOTIFY_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text }),
      });
      console.log(JSON.stringify({ event: "notified", kind: event.kind, via: "webhook", status: response.status }));
      return;
    }

    console.warn(JSON.stringify({ event: "notify_undelivered", kind: event.kind, text }));
  } catch (error) {
    console.error(JSON.stringify({ event: "notify_failed", kind: event.kind, message: String(error) }));
  }
}

// The four moments a publish attempt can end in. Both surfaces, HTTP and MCP,
// route through these so a post made from Claude Code and a post made from curl
// produce the same message and the same counters.

/** Announces a published post, and warns once when the day's quota gets tight. */
export async function announcePosted(
  env: Env,
  result: { url: string; urn: string },
  text: string,
  visibility: string,
  source: Source,
  findings: Finding[],
): Promise<void> {
  const stats = await bump(env.TOKENS, "posted", { url: result.url, excerpt: excerpt(text, 90) });
  await notify(env, {
    kind: "posted",
    url: result.url,
    urn: result.urn,
    text,
    visibility,
    source,
    warnings: findings.filter((finding) => finding.severity === "warning"),
  });
  await warnOnQuota(env, stats);
}

/**
 * Announces a draft the pipeline parked for review. Counted separately from
 * posts, because nothing was published and no LinkedIn quota was spent.
 */
export async function announceDrafted(env: Env, draft: EpisodeDraft, findings: Finding[]): Promise<void> {
  await bump(env.TOKENS, "drafted");
  await notify(env, { kind: "draft", draft, findings });
  // Sent second, and after the draft rather than with it, so the card lands
  // under the text it belongs to and never on top of it.
  await notify(env, { kind: "draft_link", draft });
}

export async function announceBlocked(env: Env, findings: Finding[], text: string, source: Source): Promise<void> {
  await bump(env.TOKENS, "blocked");
  await notify(env, { kind: "lint_blocked", findings: errorsOf(findings), text, source });
}

/** A rejection still consumed a request, so it counts against the daily quota. */
export async function announceRejected(env: Env, error: LinkedInError, source: Source): Promise<void> {
  const stats = await bump(env.TOKENS, "rejected");
  await notify(env, { kind: "linkedin_rejected", status: error.status, body: error.body, source });
  await warnOnQuota(env, stats);
}

export async function announceNoToken(env: Env, tokenExists: boolean, source: Source): Promise<void> {
  await bump(env.TOKENS, "noToken");
  await notify(env, { kind: "no_token", expired: tokenExists, source });
}

async function warnOnQuota(env: Env, stats: DayStats): Promise<void> {
  if (stats.quotaWarned || quotaUsed(stats) < QUOTA_WARN_AT) return;
  await markQuotaWarned(env.TOKENS);
  await notify(env, { kind: "quota", stats });
}
