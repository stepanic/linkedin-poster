// Telegram transport.
//
// One group, one bot, HTML formatting. This file knows nothing about LinkedIn;
// it takes rendered text and gets it into the group, or explains why it could
// not. Event wording lives in `notify.ts`.
//
// Ported from ~/git/italk/javna-nabava/src/notify.js, which learned the
// supergroup trap the expensive way. The one change the Worker forces: there is
// no .env to rewrite, so an adopted chat id is persisted in KV instead.

const API = "https://api.telegram.org";

/** Set by adoptMigratedChatId; takes precedence over the configured id. */
export const CHAT_ID_KEY = "telegram:chat-id";

/** Telegram rejects messages over 4096 characters. Leave room for the footer. */
const MAX_MESSAGE = 3900;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Escapes the three characters Telegram's HTML parse mode treats as markup. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Resolves the bot token and chat id, preferring an id adopted after a
 * supergroup migration over the configured one. Returns null when Telegram is
 * not configured at all, which is a supported state: the service falls back to
 * NOTIFY_WEBHOOK and then to the log.
 */
export async function telegramConfig(env: Env): Promise<TelegramConfig | null> {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return null;
  const adopted = await env.TOKENS.get(CHAT_ID_KEY);
  const chatId = adopted ?? env.TELEGRAM_CHAT_ID;
  if (!chatId) return null;
  return { botToken, chatId };
}

/**
 * Records the id Telegram handed back after a supergroup migration.
 *
 * Without this the next run repeats the same failed send, discovers the same
 * migration, and only succeeds on the retry. With it the migration is paid for
 * once.
 */
async function adoptMigratedChatId(env: Env, newId: string | number): Promise<void> {
  await env.TOKENS.put(CHAT_ID_KEY, String(newId));
  console.log(JSON.stringify({ event: "telegram_supergroup_migration", chatId: String(newId) }));
}

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  result?: unknown;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/**
 * Sends one message, following a supergroup migration and retrying transient
 * failures.
 *
 * A group that gets upgraded to a supergroup is handed a brand new chat_id, and
 * the old one then returns 400 for good. That is a silent failure of exactly the
 * kind this notification layer exists to prevent: the cron keeps succeeding and
 * nobody receives anything. Telegram names the replacement in
 * `parameters.migrate_to_chat_id`, so the send is retried against it
 * immediately and the id is persisted.
 */
export async function sendTelegram(
  env: Env,
  config: TelegramConfig,
  text: string,
  options: { tries?: number; baseMs?: number; silent?: boolean; apiBase?: string } = {},
): Promise<boolean> {
  // apiBase is overridden only by scripts/test-telegram.ts, which points it at
  // a local stub to exercise the migration path. That path is otherwise
  // untestable until the day it fires, which is the worst day to find a bug.
  const { tries = 4, baseMs = 1000, silent = false, apiBase = API } = options;
  let chatId = config.chatId;
  const body = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}\n…` : text;

  for (let attempt = 1; attempt <= tries; attempt++) {
    let status = 0;
    let payload: TelegramResponse = {};
    try {
      const response = await fetch(`${apiBase}/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: body,
          parse_mode: "HTML",
          // Also stops Telegram from prefetching a renewal link and burning
          // the one-time nonce before a human ever taps it.
          link_preview_options: { is_disabled: true },
          disable_notification: silent,
        }),
      });
      status = response.status;
      payload = (await response.json().catch(() => ({}))) as TelegramResponse;
      if (response.ok && payload.ok) return true;
    } catch (error) {
      // Network-level failure. Fall through to the backoff below.
      console.warn(JSON.stringify({ event: "telegram_network_error", attempt, message: String(error) }));
    }

    const migrated = payload.parameters?.migrate_to_chat_id;
    if (migrated && String(migrated) !== String(chatId)) {
      await adoptMigratedChatId(env, migrated);
      chatId = String(migrated);
      continue; // Retry in the same run, against the new id.
    }

    const transient = status === 0 || status === 429 || status >= 500;
    if (!transient || attempt === tries) {
      console.error(
        JSON.stringify({ event: "telegram_send_failed", status, description: payload.description ?? null, attempt }),
      );
      return false;
    }

    const retryAfter = Number(payload.parameters?.retry_after) * 1000;
    const wait = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : baseMs * attempt) + Math.floor(Math.random() * 300);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  return false;
}

export interface DiscoveredChat {
  id: string;
  title: string;
  type: string;
}

/**
 * Reads recent updates and lists the chats the bot has seen, so a fresh group's
 * id can be discovered without a local script. The Worker equivalent of
 * `npm run chatid` in javna-nabava.
 *
 * A bot with privacy mode on (the default) only sees messages that mention it,
 * so the group needs one `/start@botname` before anything shows up here.
 */
export async function discoverChats(botToken: string, apiBase = API): Promise<DiscoveredChat[]> {
  const response = await fetch(`${apiBase}/bot${botToken}/getUpdates?limit=100`);
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: Array<Record<string, { chat?: { id?: number; title?: string; type?: string } }>>;
  };
  if (!payload.ok || !Array.isArray(payload.result)) return [];

  const seen = new Map<string, DiscoveredChat>();
  for (const update of payload.result) {
    for (const value of Object.values(update)) {
      const chat = value?.chat;
      if (!chat?.id) continue;
      seen.set(String(chat.id), {
        id: String(chat.id),
        title: chat.title ?? "(no title)",
        type: chat.type ?? "unknown",
      });
    }
  }
  return [...seen.values()];
}
