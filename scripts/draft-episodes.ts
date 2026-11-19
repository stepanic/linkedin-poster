// Turns last night's new domovina.ai episodes into LinkedIn drafts.
//
// Runs on the Mac, as the last step of the nightly pipeline in
// fetch.domovina.tv, after the R2 upload has put the episode on the CDN. For
// every episode that is genuinely live on domovina.ai and has not been drafted
// before, it asks Claude for a post, then parks it on the Worker, which lints
// it and puts it in the Telegram group. Nothing is ever published from here.
//
// Three gates decide what counts as "new", and each one exists because the
// cheaper check is wrong on its own:
//
//   1. The summary JSON is younger than --hours. Catches the night's work.
//   2. An article JSON sits next to it. A summary alone means the AI layer is
//      half done and the episode page would be thin.
//   3. cdn.domovina.ai serves data/{id}/article.json. The disk is not the
//      product; an episode that failed to upload is not on domovina.ai, and a
//      post linking to it would 404.
//
// The state file is what keeps the group quiet. A first run on a machine with
// years of episodes on disk would otherwise draft all of them, so `--seed`
// records everything in the window without writing a word.
//
// After each draft, the episode's chapters follow it into the group, one
// message per chapter with a large preview of that moment, the same pattern as
// share_to_whatsapp.js in fetch.domovina.tv. Chapters come from the CDN, not
// the disk, so every link points at a timestamp the live page actually has.
// Sent chapters are recorded in the state file, so a rerun fills in what failed
// instead of repeating what arrived.
//
// Usage:
//   node --experimental-strip-types scripts/draft-episodes.ts [flags]
//
//   --hours N        how far back to look (default 30, one nightly plus slack)
//   --limit N        stop after N drafts (default 5, a guard against a backlog)
//   --id ID          draft this one episode, ignoring the window and the state
//   --seed           mark everything in the window as done, write no drafts
//   --dry-run        print the drafts, send nothing, touch no state
//   --no-cdn-check   skip gate 3 (for testing before an upload has run)
//   --no-chapters    drafts only, no chapter messages after them
//   --chapters-only  with --id: send that episode's chapters, write no draft
//   --chapter-delay S  seconds between chapter messages (default 3.5)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FETCH_REPO = process.env.FETCH_REPO || join(homedir(), "git", "domovinatv", "fetch.domovina.tv");
const OUTPUT_DIR = join(FETCH_REPO, "storage", "output");
const META_INDEX = join(FETCH_REPO, "storage", "meta", "channels", "data", "index.json");

const POSTER_BASE = (process.env.POSTER_BASE || "https://li.domovina.ai").replace(/\/$/, "");
const SITE_BASE = (process.env.SITE_BASE || "https://domovina.ai").replace(/\/$/, "");
const CDN_BASE = (process.env.CDN_BASE || "https://cdn.domovina.ai").replace(/\/$/, "");

const STATE_FILE = process.env.DRAFT_STATE_FILE || join(REPO, ".state", "drafted.json");

// Opus by default. A post is a few hundred tokens and gets read by a human
// before it goes anywhere, but it also carries a name and a claim, and the
// pipeline already pays for Opus on the article for the same reason.
const MODEL = process.env.DRAFT_MODEL || "opus";
const EFFORT = process.env.DRAFT_EFFORT || "medium";
/** A scratch cwd, so the CLI never picks up this repo's CLAUDE.md or settings. */
const CLAUDE_CWD = process.env.DRAFT_CLAUDE_CWD || join(homedir(), ".cache", "linkedin-poster", "claude");

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const option = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index !== -1 && index + 1 < argv.length ? argv[index + 1]! : null;
};

const HOURS = Number(option("--hours") ?? process.env.DRAFT_LOOKBACK_HOURS ?? 30);
const LIMIT = Number(option("--limit") ?? process.env.DRAFT_LIMIT ?? 5);
const ONLY_ID = option("--id");
const SEED = flag("--seed");
const DRY_RUN = flag("--dry-run");
const CDN_CHECK = !flag("--no-cdn-check");
const CHAPTERS = !flag("--no-chapters");
const CHAPTERS_ONLY = flag("--chapters-only");
// A Telegram group takes about twenty messages a minute from one bot. Three
// and a half seconds stays under that with room for the draft itself.
const CHAPTER_DELAY_MS = Number(option("--chapter-delay") ?? process.env.CHAPTER_DELAY_SEC ?? 3.5) * 1000;

interface Episode {
  id: string;
  base: string;
  dir: string;
  channelSlug: string;
  channelName: string;
  title: string;
  date: string | null;
  durationSeconds: number | null;
  abstract: string;
  topics: string[];
  keyPoints: string[];
  speakers: string[];
  url: string;
  summaryMtime: number;
}

// ─── state ────────────────────────────────────────────────────────────────

interface State {
  version: 1;
  drafted: Record<string, { at: string; channel: string; title: string }>;
  /** Chapter start seconds already in the group, per episode. */
  chapters?: Record<string, { at: string; sent: number[] }>;
}

function readState(): State {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State;
    if (parsed && typeof parsed === "object" && parsed.drafted) return parsed;
  } catch {
    // A missing or corrupt state file means "nothing drafted yet", which is
    // safe: the window plus --limit caps how much a rebuild can produce.
  }
  return { version: 1, drafted: {} };
}

function writeState(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// ─── discovery ────────────────────────────────────────────────────────────

/** Last `_yt_` wins: episode titles have been known to contain the sequence. */
function extractVideoId(base: string): string | null {
  const match = base.match(/.*_yt_([A-Za-z0-9_-]{11})(?:[._]|$)/);
  return match ? match[1]! : null;
}

function channelNames(): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const index = JSON.parse(readFileSync(META_INDEX, "utf-8")) as { channels?: Array<{ id: string; name: string }> };
    for (const channel of index.channels ?? []) names.set(channel.id, channel.name);
  } catch {
    // The index is regenerated by the same nightly run and is not essential;
    // without it the slug stands in for the channel name.
  }
  return names;
}

/**
 * The channel name for an episode the index does not know.
 *
 * Ad-hoc episodes live in `_unlisted/`, which is a directory, not a channel, so
 * the slug would otherwise reach the group as the literal string "_unlisted".
 * yt-dlp already wrote the real name next door.
 */
function channelFromInfo(dir: string, base: string): string | null {
  try {
    const info = JSON.parse(readFileSync(join(dir, `${base}.info.json`), "utf-8")) as {
      channel?: string;
      uploader?: string;
    };
    return info.channel || info.uploader || null;
  } catch {
    return null;
  }
}

interface SummaryFile {
  source?: { channel?: string; youtube_id?: string; title?: string; upload_date?: string; duration_seconds?: number };
  summary?: {
    title_hr?: string;
    abstract_hr?: string;
    key_topics?: string[];
    key_points?: string[];
    speakers?: Array<{ suggested_name?: string; role?: string }>;
  };
}

function readEpisode(dir: string, file: string, names: Map<string, string>): Episode | null {
  const base = file.replace(/\.wav\.canary\.summary\.json$/, "");
  const id = extractVideoId(base);
  if (!id) return null;

  const path = join(dir, file);
  let summary: SummaryFile;
  try {
    summary = JSON.parse(readFileSync(path, "utf-8")) as SummaryFile;
  } catch {
    return null;
  }

  // Gate 2: the article is what the episode page is made of.
  const hasArticle = readdirSync(dir).some((name) => name.startsWith(base) && name.endsWith(".article.json"));
  if (!hasArticle) return null;

  const slug = summary.source?.channel || dir.split("/").pop() || "domovina.ai";
  const speakers = (summary.summary?.speakers ?? [])
    .map((speaker) => [speaker.suggested_name, speaker.role].filter(Boolean).join(", "))
    .filter(Boolean);

  return {
    id,
    base,
    dir,
    channelSlug: slug,
    channelName: names.get(slug) || channelFromInfo(dir, base) || slug,
    title: summary.summary?.title_hr || summary.source?.title || base,
    date: summary.source?.upload_date ?? null,
    durationSeconds: summary.source?.duration_seconds ?? null,
    abstract: summary.summary?.abstract_hr ?? "",
    topics: summary.summary?.key_topics ?? [],
    keyPoints: summary.summary?.key_points ?? [],
    speakers,
    url: `${SITE_BASE}/v/${id}`,
    summaryMtime: statSync(path).mtimeMs,
  };
}

function findEpisodes(): Episode[] {
  if (!existsSync(OUTPUT_DIR)) {
    console.error(`❌ Nema ${OUTPUT_DIR}. Postavi FETCH_REPO na fetch.domovina.tv repo.`);
    process.exit(1);
  }

  const names = channelNames();
  const cutoff = Date.now() - HOURS * 3_600_000;
  const found: Episode[] = [];

  for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    // Channel dirs are symlinks to the external volume, so isDirectory() alone
    // would skip every one of them.
    const dir = join(OUTPUT_DIR, entry.name);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".wav.canary.summary.json")) continue;
      const path = join(dir, file);
      // Gate 1, before the JSON parse: a stat is cheap and most files are old.
      if (!ONLY_ID && statSync(path).mtimeMs < cutoff) continue;
      const episode = readEpisode(dir, file, names);
      if (!episode) continue;
      if (ONLY_ID && episode.id !== ONLY_ID) continue;
      found.push(episode);
    }
  }

  return found.sort((a, b) => b.summaryMtime - a.summaryMtime);
}

/** Gate 3: is it actually on domovina.ai, or only on this disk. */
async function liveOnCdn(id: string): Promise<boolean> {
  if (!CDN_CHECK) return true;
  try {
    const response = await fetch(`${CDN_BASE}/data/${id}/article.json`, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

// ─── drafting ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You write LinkedIn posts in Croatian for Matija Stepanic.

Matija builds domovina.ai: a platform that transcribes Croatian podcasts and turns
each episode into a searchable article with the full transcript. New episodes arrive
every night. Your post announces one of them and says what is actually in it.

Register: engineering. The conclusion comes first. No narrative arc, no build-up, no
reveal, no rhetorical questions, no "u ovoj epizodi saznajte", no "must-watch", no
call to action beyond the link itself. State what was said and why it is worth an
hour, in plain Croatian, the way you would tell a colleague.

Hard rules:
- Croatian. Standard, not regional.
- Never use an em-dash or an en-dash. A plain hyphen is fine.
- No markdown of any kind: no asterisks, no bullet characters, no headings. Blank
  lines between paragraphs are the only structure LinkedIn renders.
- No hashtags. No emoji.
- Between 700 and 1400 characters in total.
- LinkedIn cuts the post after roughly 200 characters behind a "see more" link, so
  the first two lines must carry the substance, not a wind-up.
- Invent nothing. Every name, number, claim and quote must come from the material
  you are given. If the material is thin, write a shorter post.
- Name a speaker only as the material names them.
- The last line is the bare episode URL, alone, with nothing after it.

Output the post body and nothing else. No preamble, no commentary, no quotation
marks around it, no code fence.`;

function userMessage(episode: Episode): string {
  const minutes = episode.durationSeconds ? Math.round(episode.durationSeconds / 60) : null;
  return [
    `Kanal: ${episode.channelName}`,
    `Naslov epizode: ${episode.title}`,
    episode.date ? `Objavljeno: ${episode.date}` : null,
    minutes ? `Trajanje: ${minutes} minuta` : null,
    episode.speakers.length ? `Sudionici: ${episode.speakers.join(" | ")}` : null,
    "",
    `Sažetak:`,
    episode.abstract || "(nema sažetka)",
    "",
    episode.topics.length ? `Teme: ${episode.topics.join(", ")}` : null,
    "",
    episode.keyPoints.length ? `Ključne točke:` : null,
    ...episode.keyPoints.map((point, index) => `${index + 1}. ${point}`),
    "",
    `URL epizode (mora biti zadnji redak objave): ${episode.url}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** The subset of the Worker's linter this script can fix before sending. */
function localFindings(text: string): string[] {
  const findings: string[] = [];
  if (text.includes("—")) findings.push("contains an em-dash (—)");
  if (text.includes("–")) findings.push("contains an en-dash (–)");
  if (/\*\*/.test(text)) findings.push("contains markdown bold (**)");
  if (/^\s*[-*]\s+\S/m.test(text)) findings.push("contains a markdown bullet list");
  if (/#\w/.test(text)) findings.push("contains a hashtag");
  if (text.length > 3000) findings.push(`is ${text.length} characters, over the 3000 LinkedIn accepts`);
  if (text.trim().length < 200) findings.push("is suspiciously short");
  return findings;
}

function tidy(text: string): string {
  return text
    .replace(/^\s*```[a-z]*\s*\n/i, "")
    .replace(/\n```\s*$/i, "")
    .trim();
}

interface ClaudeEnvelope {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
}

function callClaude(userText: string, complaint?: string): string {
  mkdirSync(CLAUDE_CWD, { recursive: true });
  const system = complaint ? `${SYSTEM_PROMPT}\n\nYour previous attempt ${complaint}. Rewrite it.` : SYSTEM_PROMPT;

  // Same invocation the pipeline uses for summaries: the prompt goes in on
  // stdin to stay clear of ARG_MAX, tools and settings are off so a headless
  // run cannot wander, and one turn is all a post needs.
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--model", MODEL,
      "--effort", EFFORT,
      "--output-format", "json",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--max-turns", "1",
      "--tools", "",
      "--system-prompt", system,
    ],
    { input: userText, encoding: "utf-8", cwd: CLAUDE_CWD, maxBuffer: 16 * 1024 * 1024 },
  );

  if (result.error) throw new Error(`claude se nije pokrenuo: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`claude exit ${result.status}: ${(result.stderr || result.stdout || "").slice(0, 400)}`);
  }

  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(result.stdout) as ClaudeEnvelope;
  } catch {
    throw new Error(`claude nije vratio JSON: ${result.stdout.slice(0, 300)}`);
  }
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`claude greška (${envelope.subtype}): ${String(envelope.result ?? "").slice(0, 300)}`);
  }
  return tidy(envelope.result ?? "");
}

/**
 * Writes one draft, and gives the model exactly one chance to fix its own
 * dashes. A second retry is not worth a second Opus call: the Worker lints the
 * text again anyway and the group sees the verdict next to the draft.
 */
function draftFor(episode: Episode): string {
  const message = userMessage(episode);
  let text = callClaude(message);
  const findings = localFindings(text);
  if (findings.length) {
    console.log(`      ↻ ponovni pokušaj: ${findings.join("; ")}`);
    text = callClaude(message, findings.join(" and "));
  }

  // A dash that survives the retry is normalised rather than dropped. The post
  // is still reviewed by a person, and a hyphen reads better than a draft the
  // linter will refuse.
  return text.replace(/\s*—\s*/g, " - ").replace(/\s*–\s*/g, " - ");
}

// ─── the claude-window guard ──────────────────────────────────────────────

/**
 * Asks the shared arbiter whether calling `claude` right now would open a fresh
 * five-hour quota window. The nightly has a long tail, and a run that spills
 * into the morning must not spend the day's quota on drafts. A deferred episode
 * is simply not recorded, so the next night picks it up.
 */
function claudeWindowClosed(): boolean {
  if (process.env.CLAUDE_WINDOW_GUARD !== "1") return false;
  const arbiter = process.env.CLAUDE_WINDOW_BIN || "claude-window";
  const result = spawnSync(arbiter, ["check"], { encoding: "utf-8" });
  if (result.error || typeof result.status !== "number") {
    console.error(`   ⚠️  arbitar '${arbiter}' nedostupan - propuštam`);
    return false;
  }
  if (result.status === 10) {
    console.log(`   ⏸️  claude-window odgodio: ${(result.stderr || "").trim() || "prozor bi se otvorio prerano"}`);
    return true;
  }
  return false;
}

// ─── delivery ─────────────────────────────────────────────────────────────

/** The bearer token, from the environment or from the .dev.vars beside it. */
function apiToken(): string {
  if (process.env.LINKEDIN_POSTER_TOKEN) return process.env.LINKEDIN_POSTER_TOKEN;
  try {
    const vars = readFileSync(join(REPO, ".dev.vars"), "utf-8");
    const match = vars.match(/^API_TOKEN=(.+)$/m);
    if (match) return match[1]!.trim();
  } catch {
    // Falls through to the error below, which names both ways to fix it.
  }
  console.error("❌ Nema API tokena. Postavi LINKEDIN_POSTER_TOKEN ili API_TOKEN u .dev.vars.");
  process.exit(1);
}

async function parkDraft(episode: Episode, text: string, token: string): Promise<void> {
  const response = await fetch(`${POSTER_BASE}/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: episode.id,
      text,
      title: episode.title,
      channel: episode.channelName,
      url: episode.url,
      episodeDate: episode.date ?? undefined,
      model: `claude-code:${MODEL}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Worker je odbio draft (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
}

// ─── chapters ─────────────────────────────────────────────────────────────

interface Chapter {
  sec: number;
  title: string;
}

/** "HH:MM:SS", "MM:SS" or "SS" to seconds; null for anything else. */
function toSeconds(stamp: unknown): number | null {
  if (typeof stamp !== "string" || !/^\d+(:\d+){0,2}$/.test(stamp.trim())) return null;
  const parts = stamp.trim().split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  if (m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * The episode's chapters, as the live page has them: every section of every
 * iteration, by screenshot timestamp, sorted, first one wins on a duplicate
 * second. Same rules as extractChapters in share_to_whatsapp.js.
 */
async function fetchChapters(id: string): Promise<Chapter[]> {
  const response = await fetch(`${CDN_BASE}/data/${id}/article.json`);
  if (!response.ok) throw new Error(`CDN nema article.json za ${id} (${response.status})`);
  const article = (await response.json()) as {
    iterations?: Array<{ sections?: Array<{ subtitle?: string; screenshot_timestamp?: string }> }>;
  };

  const seen = new Set<number>();
  const chapters: Chapter[] = [];
  for (const iteration of article.iterations ?? []) {
    for (const section of iteration.sections ?? []) {
      const sec = toSeconds(section.screenshot_timestamp);
      if (sec === null || seen.has(sec)) continue;
      seen.add(sec);
      chapters.push({ sec, title: (section.subtitle ?? "").trim() });
    }
  }
  return chapters.sort((a, b) => a.sec - b.sec);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Sends every chapter not yet in the group, in order, and records each one as
 * it lands. Stops at the first failure rather than leaving holes in the
 * sequence: the next run resumes from there.
 */
async function shareChapters(id: string, token: string, state: State): Promise<void> {
  let chapters: Chapter[];
  try {
    chapters = await fetchChapters(id);
  } catch (error) {
    console.error(`   ❌ poglavlja: ${String(error)}`);
    return;
  }

  const record = (state.chapters ??= {})[id] ?? { at: new Date().toISOString(), sent: [] };
  const done = new Set(record.sent);
  const todo = chapters.filter((chapter) => !done.has(chapter.sec));
  console.log(`   📚 ${chapters.length} poglavlja, ${todo.length} za poslati`);

  if (DRY_RUN) {
    for (const chapter of todo) console.log(`      ${chapter.sec}s · ${chapter.title}`);
    return;
  }

  let sent = 0;
  for (const chapter of todo) {
    if (sent > 0) await sleep(CHAPTER_DELAY_MS);
    const response = await fetch(`${POSTER_BASE}/drafts/${id}/chapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(chapter),
    }).catch((error: unknown) => ({ ok: false, status: 0, text: async () => String(error) }));

    if (!response.ok) {
      console.error(`   ❌ poglavlje ${chapter.sec}s nije poslano (${response.status}): ${(await response.text()).slice(0, 200)}`);
      break;
    }
    record.sent.push(chapter.sec);
    record.at = new Date().toISOString();
    state.chapters[id] = record;
    writeState(state);
    sent += 1;
  }
  console.log(`   ✅ ${sent}/${todo.length} poglavlja u Telegram grupi`);
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const state = readState();

  if (CHAPTERS_ONLY) {
    if (!ONLY_ID) {
      console.error("❌ --chapters-only traži --id.");
      process.exit(1);
    }
    console.log(`▶️  poglavlja za ${ONLY_ID}`);
    await shareChapters(ONLY_ID, DRY_RUN ? "" : apiToken(), state);
    return;
  }

  const episodes = findEpisodes();

  console.log(`📄 ${episodes.length} epizoda u prozoru od ${HOURS}h (${OUTPUT_DIR})`);

  if (SEED) {
    for (const episode of episodes) {
      state.drafted[episode.id] = { at: new Date().toISOString(), channel: episode.channelName, title: episode.title };
    }
    writeState(state);
    console.log(`🌱 Zapisano ${episodes.length} epizoda kao već obrađene. Nijedan draft nije napisan.`);
    return;
  }

  const pending = episodes.filter((episode) => ONLY_ID || !state.drafted[episode.id]);
  if (pending.length === 0) {
    console.log("✅ Nema novih epizoda za draft.");
    return;
  }

  const token = DRY_RUN ? "" : apiToken();
  let written = 0;

  for (const episode of pending) {
    if (written >= LIMIT) {
      console.log(`⏹️  Limit ${LIMIT} dosegnut. Ostatak ide sljedeći put.`);
      break;
    }

    console.log(`\n▶️  ${episode.channelName} · ${episode.title} (${episode.id})`);

    if (!(await liveOnCdn(episode.id))) {
      console.log("   ⏭️  još nije na CDN-u (data/<id>/article.json) - preskačem, javit će se sutra");
      continue;
    }
    if (claudeWindowClosed()) break;

    let text: string;
    try {
      text = draftFor(episode);
    } catch (error) {
      console.error(`   ❌ ${String(error)}`);
      continue;
    }

    const findings = localFindings(text);
    console.log(`   📝 ${text.length} znakova${findings.length ? ` · upozorenja: ${findings.join("; ")}` : ""}`);

    if (DRY_RUN) {
      console.log("   ─────────────────────────────────────────");
      console.log(text.split("\n").map((line) => `   ${line}`).join("\n"));
      console.log("   ─────────────────────────────────────────");
      written += 1;
      continue;
    }

    try {
      await parkDraft(episode, text, token);
    } catch (error) {
      console.error(`   ❌ ${String(error)}`);
      continue;
    }

    state.drafted[episode.id] = { at: new Date().toISOString(), channel: episode.channelName, title: episode.title };
    writeState(state);
    written += 1;
    console.log(`   ✅ draft ${episode.id} u Telegram grupi`);

    if (CHAPTERS) {
      // The Worker announces the draft after it answers. A short pause lets the
      // draft and its card land first, so the chapters sit underneath them.
      await sleep(5000);
      await shareChapters(episode.id, token, state);
    }
  }

  console.log(`\n🧾 Gotovo: ${written} draft(ova)${DRY_RUN ? " (dry run)" : ""}.`);
}

main().catch((error) => {
  console.error(`❌ ${String(error)}`);
  process.exit(1);
});
