// Telegram kanal po podcastu: mapiranje YouTube channel_id → chat.
//
// Kanale stvara MTProto provisioner na Macu (scripts/provision), jer Bot API ne
// može stvoriti ni grupu ni kanal. Ovdje se samo pamti što je stvoreno, da bi
// /drafts/{id}/chapters znao kamo poslati poglavlja.
//
// Ključ je YouTube channel_id, ne slug pipelinea: Tier 2 epizode žive u
// `_unlisted/`, pa im je slug doslovno "_unlisted".

export interface PodcastChat {
  youtubeChannelId: string;
  /** Bot API oblik (-100…) kanala za objave. */
  chatId: string;
  /** Povezana grupa za raspravu, ako postoji. */
  discussionChatId: string | null;
  link: string;
  title: string;
  createdAt: string;
}

const key = (youtubeChannelId: string) => `tg:podcast:${youtubeChannelId}`;

export function isYoutubeChannelId(value: unknown): value is string {
  return typeof value === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(value);
}

export async function getPodcastChat(kv: KVNamespace, youtubeChannelId: string): Promise<PodcastChat | null> {
  return await kv.get<PodcastChat>(key(youtubeChannelId), "json");
}

/** Validira tijelo PUT-a; vraća grešku kao tekst ili spremljeni zapis. */
export async function putPodcastChat(
  kv: KVNamespace,
  youtubeChannelId: string,
  body: Record<string, unknown>,
): Promise<PodcastChat | string> {
  const chatId = String(body.chatId ?? "");
  if (!/^-100\d{5,}$/.test(chatId)) return "chatId mora biti Bot API id kanala (-100…)";
  const discussion = body.discussionChatId == null ? null : String(body.discussionChatId);
  if (discussion !== null && !/^-100\d{5,}$/.test(discussion)) return "discussionChatId mora biti -100… ili null";
  const link = String(body.link ?? "");
  if (!/^https:\/\/t\.me\//.test(link)) return "link mora biti https://t.me/…";
  const title = String(body.title ?? "").trim().slice(0, 128);
  if (!title) return "title je obavezan";

  const chat: PodcastChat = {
    youtubeChannelId,
    chatId,
    discussionChatId: discussion,
    link,
    title,
    createdAt: typeof body.createdAt === "string" ? body.createdAt : new Date().toISOString(),
  };
  await kv.put(key(youtubeChannelId), JSON.stringify(chat));
  return chat;
}
