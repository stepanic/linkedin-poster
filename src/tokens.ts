// Token storage and constant-time secret comparison.
//
// LinkedIn issues 60-day access tokens. Programmatic refresh tokens exist but
// are limited to approved Marketing Developer Platform partners, so a
// self-serve "Share on LinkedIn" app never receives one. The token in KV is
// therefore the whole state of this service, and renewing it means sending a
// human through the browser again.

export const TOKEN_KEY = "token";
export const LAST_NOTIFIED_KEY = "last-renewal-notice";
/** Holds the nonce that makes the renewal link in a chat message work. */
export const RENEW_NONCE_KEY = "renew:nonce";

/**
 * A renewal link has to outlive the gap between two reminders (14, 7, 3, 1 and
 * 0 days out, so seven days at the widest) or the older message would carry a
 * dead link.
 */
const RENEW_NONCE_TTL_SECONDS = 7 * 86_400;

export interface TokenRecord {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Epoch milliseconds. */
  obtainedAt: number;
  /** urn:li:person:{sub} — the author of every post this service makes. */
  personUrn: string;
  name?: string;
  scope?: string;
}

export async function readToken(kv: KVNamespace): Promise<TokenRecord | null> {
  return await kv.get<TokenRecord>(TOKEN_KEY, "json");
}

export async function writeToken(kv: KVNamespace, record: TokenRecord): Promise<void> {
  await kv.put(TOKEN_KEY, JSON.stringify(record));
}

export function daysLeft(record: TokenRecord, now = Date.now()): number {
  return Math.floor((record.expiresAt - now) / 86_400_000);
}

export function isExpired(record: TokenRecord, now = Date.now()): boolean {
  return record.expiresAt <= now;
}

/**
 * Constant-time secret comparison.
 *
 * `crypto.subtle.timingSafeEqual` throws when the two buffers differ in length,
 * which would itself leak the length. Hashing both sides first makes every
 * comparison the same width and keeps the check genuinely constant-time.
 */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}

/** Reads a bearer token from the Authorization header, or null. */
export function bearerFrom(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Mints the one-time credential behind the renewal link in a chat message.
 *
 * The alternative was putting SETUP_KEY in the link, which would park a
 * long-lived secret in a chat log and on Telegram's servers for good. A nonce
 * costs one KV write, expires on its own, and is thrown away the moment a token
 * is stored, so a message that has already been acted on stops being useful to
 * anyone who reads it later.
 *
 * Each minting replaces the previous nonce: only the newest reminder works.
 */
export async function mintRenewalNonce(kv: KVNamespace): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  await kv.put(RENEW_NONCE_KEY, nonce, { expirationTtl: RENEW_NONCE_TTL_SECONDS });
  return nonce;
}

/** True when the presented nonce is the current one. */
export async function renewalNonceMatches(kv: KVNamespace, presented: string): Promise<boolean> {
  if (!presented) return false;
  const stored = await kv.get(RENEW_NONCE_KEY);
  if (!stored) return false;
  return await secretsMatch(presented, stored);
}

/** Called once a fresh token is stored: the outstanding link has done its job. */
export async function clearRenewalNonce(kv: KVNamespace): Promise<void> {
  await kv.delete(RENEW_NONCE_KEY);
}
