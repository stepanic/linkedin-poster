// Exercises the Telegram transport against a local stub of the Bot API.
//
//   npm run test:telegram
//
// The supergroup migration is the reason this file exists. It is a failure that
// happens once, without warning, months after setup, and it is silent: the cron
// keeps succeeding while nobody receives anything. There is no way to rehearse
// it against the real API, so the API is faked here instead.
//
// No test framework and no build step. Node strips the types, and src/telegram.ts
// imports nothing, so it loads as-is.

import { createServer } from "node:http";
import { CHAT_ID_KEY, discoverChats, esc, sendTelegram, type TelegramConfig } from "../src/telegram.ts";

const ORIGINAL_CHAT = "-4123456789";
const MIGRATED_CHAT = "-1001234567890";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

/** Just enough of a KVNamespace for the transport, plus a window into it. */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

interface Received {
  chat_id: string;
  text: string;
  parse_mode?: string;
  link_preview_options?: { is_disabled?: boolean };
}

/**
 * A stub Bot API. `script` decides what each successive sendMessage gets back,
 * so a test can stage a migration, a rate limit or an outage.
 */
function stubTelegram(script: Array<{ status: number; body: unknown }>) {
  const received: Received[] = [];
  let call = 0;

  const server = createServer((req, res) => {
    if (req.url?.includes("/getUpdates")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: [
            { message: { chat: { id: -4123456789, title: "linkedin-poster", type: "group" } } },
            { message: { chat: { id: -4123456789, title: "linkedin-poster", type: "group" } } },
            { edited_message: { chat: { id: 987654, title: undefined, type: "private" } } },
          ],
        }),
      );
      return;
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push(JSON.parse(raw) as Received);
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      res.writeHead(step.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(step.body));
    });
  });

  return {
    received,
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address === "string" || address === null) throw new Error("no port");
      return `http://127.0.0.1:${address.port}`;
    },
    stop: () => server.close(),
  };
}

const OK_BODY = { ok: true, result: { message_id: 1 } };
const config: TelegramConfig = { botToken: "stub:token", chatId: ORIGINAL_CHAT };

async function testHappyPath(): Promise<void> {
  console.log("\na plain send");
  const stub = stubTelegram([{ status: 200, body: OK_BODY }]);
  const apiBase = await stub.start();
  const kv = fakeKv();

  const sent = await sendTelegram({ TOKENS: kv } as unknown as Env, config, "<b>hello</b>", { apiBase });

  check("reports success", sent);
  check("sends HTML", stub.received[0]?.parse_mode === "HTML");
  check("disables the link preview", stub.received[0]?.link_preview_options?.is_disabled === true);
  check("leaves the chat id alone", kv.store.get(CHAT_ID_KEY) === undefined);
  stub.stop();
}

async function testSupergroupMigration(): Promise<void> {
  console.log("\nthe group becomes a supergroup");
  const stub = stubTelegram([
    {
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        parameters: { migrate_to_chat_id: Number(MIGRATED_CHAT) },
      },
    },
    { status: 200, body: OK_BODY },
  ]);
  const apiBase = await stub.start();
  const kv = fakeKv();

  const sent = await sendTelegram({ TOKENS: kv } as unknown as Env, config, "summary", { apiBase });

  check("the message still arrives", sent);
  check("it is retried in the same run", stub.received.length === 2, `${stub.received.length} attempt(s)`);
  check("the retry uses the new id", stub.received[1]?.chat_id === MIGRATED_CHAT, stub.received[1]?.chat_id);
  check("the new id is persisted", kv.store.get(CHAT_ID_KEY) === MIGRATED_CHAT, kv.store.get(CHAT_ID_KEY));
  check("the text is unchanged", stub.received[1]?.text === "summary");
  stub.stop();
}

async function testMigrationIsPaidOnce(): Promise<void> {
  console.log("\nthe next run after a migration");
  const stub = stubTelegram([{ status: 200, body: OK_BODY }]);
  const apiBase = await stub.start();
  const kv = fakeKv();
  await kv.put(CHAT_ID_KEY, MIGRATED_CHAT);

  // What telegramConfig() would resolve on the following day.
  const adopted = (await kv.get(CHAT_ID_KEY)) ?? ORIGINAL_CHAT;
  const sent = await sendTelegram({ TOKENS: kv } as unknown as Env, { ...config, chatId: adopted }, "next day", {
    apiBase,
  });

  check("succeeds first try", sent && stub.received.length === 1);
  check("goes straight to the new id", stub.received[0]?.chat_id === MIGRATED_CHAT);
  stub.stop();
}

async function testTransientRetry(): Promise<void> {
  console.log("\na rate limit, then an outage");
  const stub = stubTelegram([
    { status: 429, body: { ok: false, parameters: { retry_after: 0 } } },
    { status: 502, body: { ok: false, description: "Bad Gateway" } },
    { status: 200, body: OK_BODY },
  ]);
  const apiBase = await stub.start();
  const kv = fakeKv();

  const sent = await sendTelegram({ TOKENS: kv } as unknown as Env, config, "retry me", { apiBase, baseMs: 1 });

  check("recovers", sent);
  check("after three attempts", stub.received.length === 3, `${stub.received.length}`);
  stub.stop();
}

async function testPermanentFailure(): Promise<void> {
  console.log("\na chat the bot was removed from");
  const stub = stubTelegram([{ status: 403, body: { ok: false, description: "Forbidden: bot was kicked" } }]);
  const apiBase = await stub.start();
  const kv = fakeKv();

  const sent = await sendTelegram({ TOKENS: kv } as unknown as Env, config, "nobody home", { apiBase, baseMs: 1 });

  check("reports failure rather than throwing", sent === false);
  check("does not retry a permanent error", stub.received.length === 1, `${stub.received.length}`);
  stub.stop();
}

async function testDiscovery(): Promise<void> {
  console.log("\nchat id discovery");
  const stub = stubTelegram([{ status: 200, body: OK_BODY }]);
  const apiBase = await stub.start();

  const chats = await discoverChats("stub:token", apiBase);

  check("deduplicates repeated chats", chats.length === 2, `${chats.length}`);
  check("finds the group", chats.some((chat) => chat.id === ORIGINAL_CHAT && chat.type === "group"));
  check("survives a missing title", chats.some((chat) => chat.title === "(no title)"));
  stub.stop();
}

function testEscaping(): void {
  console.log("\nHTML escaping");
  check("escapes markup", esc('<script>&"') === "&lt;script&gt;&amp;\"");
  check("handles null", esc(null) === "");
}

await testHappyPath();
await testSupergroupMigration();
await testMigrationIsPaidOnce();
await testTransientRetry();
await testPermanentFailure();
await testDiscovery();
testEscaping();

console.log(failures === 0 ? "\nall good\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
