// Post drafts waiting for a human.
//
// The nightly pipeline in fetch.domovina.tv writes an episode to domovina.ai
// and then asks this service to turn it into a LinkedIn post. Nothing is
// published automatically: the draft is parked in KV, announced in the group,
// and only goes out when a person says so from Claude Code.
//
// KV is the right store for this. A draft is small, read once or twice, and
// worthless after a week or two, so the TTL does the cleanup that a table would
// otherwise need a cron for. The youtube id is the key, which makes the whole
// thing idempotent: a pipeline that re-runs the same episode overwrites its own
// draft instead of filling the group with copies.

export const DRAFT_PREFIX = "draft:";

/** Long enough to survive a holiday, short enough that KV cleans itself. */
export const DRAFT_TTL_SECONDS = 14 * 86_400;

export interface EpisodeDraft {
  /** The YouTube id of the episode, which is also the KV key suffix. */
  id: string;
  /** The post body, exactly as it would appear on LinkedIn. */
  text: string;
  /** Episode title, in Croatian where the pipeline produced one. */
  title: string;
  /** Channel name as shown in the app, not the slug. */
  channel: string;
  /** Episode page on domovina.ai. */
  url: string;
  /** Upload date of the episode, YYYY-MM-DD. */
  episodeDate?: string;
  /** Which model wrote the draft, so a bad batch can be traced to its author. */
  model?: string;
  /** Epoch milliseconds, set when the draft was stored. */
  createdAt: number;
}

/** What `list` can show without reading every value. */
export interface DraftSummary {
  id: string;
  title: string;
  channel: string;
  chars: number;
  createdAt: number;
}

function keyOf(id: string): string {
  return `${DRAFT_PREFIX}${id}`;
}

/**
 * Ids come from filenames on another machine, so they are treated as untrusted
 * input: anything that is not a YouTube id is refused rather than turned into a
 * KV key of its own shape.
 */
export function isDraftId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,24}$/.test(value);
}

export async function putDraft(kv: KVNamespace, draft: EpisodeDraft): Promise<void> {
  const metadata: DraftSummary = {
    id: draft.id,
    title: draft.title,
    channel: draft.channel,
    chars: draft.text.length,
    createdAt: draft.createdAt,
  };
  await kv.put(keyOf(draft.id), JSON.stringify(draft), {
    expirationTtl: DRAFT_TTL_SECONDS,
    metadata,
  });
}

export async function getDraft(kv: KVNamespace, id: string): Promise<EpisodeDraft | null> {
  if (!isDraftId(id)) return null;
  return await kv.get<EpisodeDraft>(keyOf(id), "json");
}

export async function deleteDraft(kv: KVNamespace, id: string): Promise<void> {
  if (!isDraftId(id)) return;
  await kv.delete(keyOf(id));
}

/**
 * Lists open drafts, newest first.
 *
 * The metadata written alongside each draft carries everything a list needs, so
 * this is one KV operation no matter how many drafts are waiting.
 */
export async function listDrafts(kv: KVNamespace, limit = 20): Promise<DraftSummary[]> {
  const listed = await kv.list<DraftSummary>({ prefix: DRAFT_PREFIX, limit: 100 });
  return listed.keys
    .map((key) => key.metadata)
    .filter((meta): meta is DraftSummary => Boolean(meta))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
