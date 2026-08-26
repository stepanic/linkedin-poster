// Token storage and constant-time secret comparison.
//
// LinkedIn issues 60-day access tokens. Programmatic refresh tokens exist but
// are limited to approved Marketing Developer Platform partners, so a
// self-serve "Share on LinkedIn" app never receives one. The token in KV is
// therefore the whole state of this service, and renewing it means sending a
// human through the browser again.

export const TOKEN_KEY = "token";
export const LAST_NOTIFIED_KEY = "last-renewal-notice";

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
