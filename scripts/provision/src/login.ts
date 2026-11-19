// Jednokratni interaktivni MTProto login (zaseban Domovina račun) → ispiše StringSession.
// Session spremi u provision/.env kao TG_SESSION — NIKAD u repo.
//
//   npm run login

import "dotenv/config";
import * as readline from "node:readline/promises";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const apiId = Number(process.env.TG_API_ID || (await rl.question("TG_API_ID (my.telegram.org → API development tools): ")));
const apiHash = process.env.TG_API_HASH || (await rl.question("TG_API_HASH: "));
if (!apiId || !apiHash) {
  console.error("TG_API_ID i TG_API_HASH su obavezni.");
  process.exit(1);
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () => (await rl.question("Telefon (+385…): ")).trim(),
  password: async () => (await rl.question("2FA lozinka (Enter ako nema): ")).trim(),
  phoneCode: async () => (await rl.question("Kod iz Telegrama: ")).trim(),
  onError: (err) => console.error(err),
});

const me = await client.getMe();
const session = (client.session as StringSession).save();

console.log(`\n✅ Prijavljen kao: ${me.username ? "@" + me.username : me.firstName}\n`);
console.log("Dodaj u provision/.env (NIKAD u repo):\n");
console.log(`TG_SESSION=${session}\n`);

await client.disconnect();
rl.close();
process.exit(0);
