// Telegram kanal + grupa za raspravu za JEDAN podcast (MTProto, teleproto).
//
//   npm run create-channel -- <YouTube channel_id UC…> --title "Naziv · domovina.ai"
//                              [--avatar <url>] [--about "opis"] [--public <username>]
//                              [--slow 10] [--dry-run] [--json]
//
// Zašto MTProto: Bot API nema metodu za stvaranje grupe ni kanala. Bot (ms-social-poster)
// samo objavljuje u kanal u koji ga ovdje promoviramo u admina.
//
// Tijek:
//   0. GET li.domovina.ai/telegram/podcasts/<UC…>  — već postoji → ispiši i izađi (bez duplikata)
//   1. channels.CreateChannel(broadcast)           — kanal za objave (poglavlja)
//   2. channels.CreateChannel(megagroup)           — grupa za raspravu („… · rasprava”)
//   3. channels.SetDiscussionGroup                 — komentari ispod svake objave kanala
//   4. channels.EditAdmin bot na kanalu (objava) i u grupi (moderacija)
//   5. channels.EditPhoto oboma                    — avatar podcasta s cdn.domovina.ai
//   6. --public: UpdateUsername kanala; inače ExportChatInvite (obični link, bez join requesta)
//   7. grupa: povijest vidljiva, slow mode, anti-spam (best-effort)
//   8. PUT li.domovina.ai/telegram/podcasts/<UC…>  — mapiranje u KV Workera
//
// Mapiranje je ključano YouTube channel_id-em, ne slugom: Tier 2 epizode žive u
// `_unlisted/`, pa im je slug iz pipelinea doslovno "_unlisted".
//
// Izlaz: ljudski log na stderr; uz --json na stdout ide JEDAN JSON redak (PodcastChat),
// koji čita scripts/draft-episodes.ts.

import "dotenv/config";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Api, TelegramClient } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { StringSession } from "teleproto/sessions";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSTER_REPO = path.resolve(HERE, "../../..");

// --- argumenti ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Map<string, string | boolean>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--dry-run" || a === "--json") flags.set(a, true);
  else if (["--title", "--avatar", "--about", "--public", "--slow"].includes(a)) flags.set(a, argv[++i] ?? "");
  else positional.push(a);
}

const log = (...parts: unknown[]) => console.error(...parts);
const usage =
  'Upotreba: npm run create-channel -- <UC…> --title "Naziv · domovina.ai" [--avatar <url>] [--about "…"] [--public <username>] [--slow 10] [--dry-run] [--json]';

const youtubeChannelId = positional[0] ?? "";
if (!/^UC[A-Za-z0-9_-]{22}$/.test(youtubeChannelId)) {
  log(`Nevaljan YouTube channel_id '${youtubeChannelId}'.\n${usage}`);
  process.exit(1);
}
const title = String(flags.get("--title") ?? "").trim();
if (!title) {
  log(`Nedostaje --title.\n${usage}`);
  process.exit(1);
}
const discussionTitle = `${title.replace(/\s*·\s*domovina\.ai$/, "")} · rasprava`;
const avatarUrl = (flags.get("--avatar") as string | undefined) || null;
const about =
  (flags.get("--about") as string | undefined) ||
  "Poglavlja svake nove epizode s domovina.ai: svaka poruka vodi točno na trenutak u snimci.";
const publicUsername = (flags.get("--public") as string | undefined) || null;
if (publicUsername && !/^[a-zA-Z][a-zA-Z0-9_]{3,30}[a-zA-Z0-9]$/.test(publicUsername)) {
  log(`Nevaljan Telegram username '${publicUsername}' — 5–32 znaka, [a-z0-9_], počinje slovom.`);
  process.exit(1);
}
const slowSeconds = Number(flags.get("--slow") ?? 10);
const dryRun = flags.get("--dry-run") === true;
const jsonOut = flags.get("--json") === true;

// --- Worker (mapiranje u KV) --------------------------------------------------
const POSTER_BASE = (process.env.POSTER_BASE || "https://li.domovina.ai").replace(/\/$/, "");

function posterToken(): string {
  if (process.env.LINKEDIN_POSTER_TOKEN) return process.env.LINKEDIN_POSTER_TOKEN;
  try {
    const match = readFileSync(path.join(POSTER_REPO, ".dev.vars"), "utf-8").match(/^API_TOKEN=(.+)$/m);
    if (match) return match[1]!.trim();
  } catch {
    // pada na grešku ispod
  }
  log("❌ Nema API tokena Workera. Postavi LINKEDIN_POSTER_TOKEN ili API_TOKEN u linkedin-poster/.dev.vars.");
  process.exit(1);
}

interface PodcastChat {
  youtubeChannelId: string;
  chatId: string;
  discussionChatId: string | null;
  link: string;
  title: string;
  createdAt: string;
}

async function existingMapping(token: string): Promise<PodcastChat | null> {
  const response = await fetch(`${POSTER_BASE}/telegram/podcasts/${youtubeChannelId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET mapiranja vratio ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as PodcastChat;
}

async function storeMapping(token: string, chat: PodcastChat): Promise<void> {
  const response = await fetch(`${POSTER_BASE}/telegram/podcasts/${youtubeChannelId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(chat),
  });
  if (!response.ok) throw new Error(`PUT mapiranja vratio ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

function emit(chat: PodcastChat): void {
  if (jsonOut) process.stdout.write(`${JSON.stringify(chat)}\n`);
}

// --- 0) već postoji? ------------------------------------------------------------
const token = posterToken();
const existing = await existingMapping(token);
if (existing) {
  log(`✓ ${youtubeChannelId} već ima Telegram: ${existing.title} (${existing.chatId}) ${existing.link}`);
  emit(existing);
  process.exit(0);
}

if (dryRun) {
  log(`▸ [dry-run] stvorio bih kanal „${title}” + grupu „${discussionTitle}” za ${youtubeChannelId}`);
  log(`  avatar: ${avatarUrl ?? "-"} · ${publicUsername ? `javni @${publicUsername}` : "privatni invite link"} · slow ${slowSeconds}s`);
  process.exit(0);
}

// --- env (secrets — nikad u repo) ---------------------------------------------
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH ?? "";
const sessionStr = process.env.TG_SESSION ?? "";
const botUsername = process.env.TG_BOT_USERNAME ?? "";
if (!apiId || !apiHash || !sessionStr || !botUsername) {
  log("❌ Nedostaje TG_API_ID / TG_API_HASH / TG_SESSION / TG_BOT_USERNAME u scripts/provision/.env — prvo `npm run login`.");
  process.exit(1);
}

const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
await client.connect();
if (!(await client.checkAuthorization())) {
  log("❌ TG_SESSION nije valjan — ponovi `npm run login`.");
  process.exit(1);
}

function channelFrom(updates: Api.TypeUpdates): Api.Channel {
  const chats = updates instanceof Api.Updates ? updates.chats : [];
  const channel = chats.find((c): c is Api.Channel => c instanceof Api.Channel);
  if (!channel) throw new Error("CreateChannel nije vratio kanal");
  return channel;
}
const botApiId = (channel: Api.Channel) => `-100${channel.id.toString()}`;

// 1) kanal za objave
log(`▸ Kanal „${title}” (${youtubeChannelId})…`);
const channel = channelFrom(await client.invoke(new Api.channels.CreateChannel({ broadcast: true, title, about })));
log(`  ✓ kanal ${botApiId(channel)}`);

// 2) grupa za raspravu
const group = channelFrom(
  await client.invoke(new Api.channels.CreateChannel({ megagroup: true, title: discussionTitle, about })),
);
log(`  ✓ grupa ${botApiId(group)}`);

// 3) poveži: komentari ispod svake objave kanala
await client.invoke(new Api.channels.SetDiscussionGroup({ broadcast: channel, group }));
log("  ✓ grupa povezana kao rasprava kanala");

// 4) bot: objavljuje u kanal, moderira grupu
const bot = await client.getEntity(botUsername.startsWith("@") ? botUsername : `@${botUsername}`);
await client.invoke(
  new Api.channels.EditAdmin({
    channel,
    userId: bot,
    adminRights: new Api.ChatAdminRights({ postMessages: true, editMessages: true, deleteMessages: true, inviteUsers: true }),
    rank: "bot",
  }),
);
await client.invoke(
  new Api.channels.EditAdmin({
    channel: group,
    userId: bot,
    adminRights: new Api.ChatAdminRights({ deleteMessages: true, banUsers: true, pinMessages: true, inviteUsers: true }),
    rank: "bot",
  }),
);
log(`  ✓ ${botUsername} admin u kanalu i grupi`);

// 5) avatar podcasta (best-effort: kanal bez slike i dalje radi)
if (avatarUrl) {
  try {
    const response = await fetch(avatarUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    for (const target of [channel, group]) {
      // upload po meti: InputFile se troši na jednom EditPhoto
      const file = await client.uploadFile({ file: new CustomFile("avatar.jpg", buffer.length, "", buffer), workers: 1 });
      await client.invoke(
        new Api.channels.EditPhoto({ channel: target, photo: new Api.InputChatUploadedPhoto({ file }) }),
      );
    }
    log("  ✓ avatar postavljen");
  } catch (error) {
    log(`  ⚠ avatar nije postavljen (${String(error)}) — postavi ručno`);
  }
}

// 6) link
let link: string;
if (publicUsername) {
  const free = await client.invoke(new Api.channels.CheckUsername({ channel, username: publicUsername }));
  if (!free) throw new Error(`username @${publicUsername} je zauzet; kanal ${botApiId(channel)} je stvoren kao privatan`);
  await client.invoke(new Api.channels.UpdateUsername({ channel, username: publicUsername }));
  link = `https://t.me/${publicUsername}`;
} else {
  const exported = await client.invoke(new Api.messages.ExportChatInvite({ peer: channel, title: "domovina.ai" }));
  if (!(exported instanceof Api.ChatInviteExported)) throw new Error("ExportChatInvite: nepoznat oblik odgovora");
  link = exported.link;
}
log(`  ✓ link ${link}`);

// 7) grupa: povijest, slow mode, anti-spam (sve best-effort)
for (const [label, request] of [
  ["povijest vidljiva", new Api.channels.TogglePreHistoryHidden({ channel: group, enabled: false })],
  [`slow mode ${slowSeconds}s`, new Api.channels.ToggleSlowMode({ channel: group, seconds: slowSeconds })],
  ["anti-spam", new Api.channels.ToggleAntiSpam({ channel: group, enabled: true })],
] as const) {
  try {
    await client.invoke(request);
    log(`  ✓ grupa: ${label}`);
  } catch (error) {
    log(`  ⚠ grupa: ${label} nije prošlo (${String(error)})`);
  }
}

await client.disconnect();

// 8) mapiranje u KV Workera
const chat: PodcastChat = {
  youtubeChannelId,
  chatId: botApiId(channel),
  discussionChatId: botApiId(group),
  link,
  title,
  createdAt: new Date().toISOString(),
};
try {
  await storeMapping(token, chat);
  log(`  ✓ mapiranje upisano u Worker (${POSTER_BASE})`);
} catch (error) {
  // Kanal postoji, a Worker ga ne zna: bez ovog ispisa idući run bi stvorio duplikat.
  log(`  ❌ ${String(error)}\n  Upiši ručno: curl -X PUT ${POSTER_BASE}/telegram/podcasts/${youtubeChannelId} -H 'Authorization: Bearer …' -d '${JSON.stringify(chat)}'`);
  process.exit(2);
}

log(`\n✅ ${title}\n   kanal ${chat.chatId} · rasprava ${chat.discussionChatId}\n   ${link}`);
emit(chat);
process.exit(0);
