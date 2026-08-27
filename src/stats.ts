// Daily counters behind the heartbeat.
//
// The daily summary has to say something even on a day when nothing happened,
// so the day's events are tallied in KV as they occur and read back by the
// cron. One key per UTC day, expiring on its own.
//
// These are counters, not an audit log. KV is eventually consistent and a
// read-modify-write can drop a concurrent increment; at a handful of posts a
// day that is a rounding error, and nothing downstream makes a decision that a
// lost count would change. Anything that must not be lost goes to the log
// instead.

/** LinkedIn allows this many requests per member per day, not per app. */
export const DAILY_POST_QUOTA = 150;

/** Warn once when the day's consumption crosses this. */
export const QUOTA_WARN_AT = 120;

const STATS_PREFIX = "stats:";
const STATS_TTL_SECONDS = 7 * 86_400;

/** How many post excerpts the summary keeps. Enough to recognise the day. */
const KEPT_POSTS = 8;

export interface DayStats {
  /** Posts LinkedIn accepted. */
  posted: number;
  /** Drafts the linter refused. */
  blocked: number;
  /** Posts LinkedIn rejected. */
  rejected: number;
  /** Publish attempts that found no usable token. */
  noToken: number;
  /** Requests turned away by the bearer or setup-key guard. */
  unauthorized: number;
  /** Set once the quota warning has gone out, so it goes out only once. */
  quotaWarned: boolean;
  /** Newest first, capped at KEPT_POSTS. */
  posts: Array<{ url: string; excerpt: string }>;
}

const EMPTY: DayStats = {
  posted: 0,
  blocked: 0,
  rejected: 0,
  noToken: 0,
  unauthorized: 0,
  quotaWarned: false,
  posts: [],
};

/** UTC day, matching the cron's own clock. */
export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function readStats(kv: KVNamespace, day = dayKey()): Promise<DayStats> {
  const stored = await kv.get<DayStats>(`${STATS_PREFIX}${day}`, "json");
  return { ...EMPTY, ...(stored ?? {}) };
}

async function writeStats(kv: KVNamespace, day: string, stats: DayStats): Promise<void> {
  await kv.put(`${STATS_PREFIX}${day}`, JSON.stringify(stats), { expirationTtl: STATS_TTL_SECONDS });
}

/** Requests that count against the member's daily allowance. */
export function quotaUsed(stats: DayStats): number {
  return stats.posted + stats.rejected;
}

/**
 * Increments one counter and returns the updated day.
 *
 * `post` is recorded alongside a `posted` bump so the summary can name what
 * went out without a second write.
 */
export async function bump(
  kv: KVNamespace,
  field: "posted" | "blocked" | "rejected" | "noToken" | "unauthorized",
  post?: { url: string; excerpt: string },
): Promise<DayStats> {
  const day = dayKey();
  const stats = await readStats(kv, day);
  stats[field] += 1;
  if (post) stats.posts = [post, ...stats.posts].slice(0, KEPT_POSTS);
  await writeStats(kv, day, stats);
  return stats;
}

/** Marks the quota warning as sent, so the next post does not repeat it. */
export async function markQuotaWarned(kv: KVNamespace): Promise<void> {
  const day = dayKey();
  const stats = await readStats(kv, day);
  stats.quotaWarned = true;
  await writeStats(kv, day, stats);
}

/** True when nothing at all happened, which the summary states plainly. */
export function isQuiet(stats: DayStats): boolean {
  return stats.posted + stats.blocked + stats.rejected + stats.noToken + stats.unauthorized === 0;
}
