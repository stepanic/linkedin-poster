// LinkedIn API client: 3-legged OAuth plus the versioned Posts API.
//
// Endpoints and headers verified against Microsoft Learn on 2026-08-26:
//   /oauth/v2/authorization, /oauth/v2/accessToken   (3-legged OAuth)
//   /v2/userinfo                                     (OIDC, gives `sub`)
//   /rest/posts                                      (Posts API, replaces ugcPosts)

import type { TokenRecord } from "./tokens";

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const POSTS_URL = "https://api.linkedin.com/rest/posts";

/**
 * `openid profile` identify the member (we need `sub` to build the author URN),
 * `w_member_social` is what actually allows posting. All three are Open
 * Permissions — self-serve, no partner approval. Changing this list invalidates
 * every token already issued, so the member must re-authorize afterwards.
 */
export const SCOPES = ["openid", "profile", "w_member_social"] as const;

export type Visibility = "PUBLIC" | "CONNECTIONS";

export class LinkedInError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "LinkedInError";
  }
}

export function authorizationUrl(clientId: string, redirectUri: string, state: string): string {
  // Built by hand rather than with URLSearchParams: that encodes the spaces
  // between scopes as "+", and LinkedIn's authorization endpoint expects the
  // %20 form its docs specify. The failure mode otherwise is a 401
  // "Invalid scope" that looks like a portal misconfiguration.
  const query = [
    ["response_type", "code"],
    ["client_id", clientId],
    ["redirect_uri", redirectUri],
    ["state", state],
    ["scope", SCOPES.join(" ")],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
    .join("&");
  return `${AUTHORIZE_URL}?${query}`;
}

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<AccessTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new LinkedInError("Token exchange failed", response.status, text);
  }
  return JSON.parse(text) as AccessTokenResponse;
}

interface UserInfo {
  sub: string;
  name?: string;
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new LinkedInError("userinfo failed", response.status, text);
  }
  return JSON.parse(text) as UserInfo;
}

export interface PostResult {
  urn: string;
  url: string;
}

/**
 * Publishes a text post on the member's own feed.
 *
 * The Posts API deliberately does not scrape URLs, so a bare link in the text
 * stays a bare link. A real link preview needs the Images API for a thumbnail
 * plus a `content.article` block, which is a separate feature.
 */
export async function createTextPost(
  token: TokenRecord,
  linkedinVersion: string,
  commentary: string,
  visibility: Visibility = "PUBLIC",
): Promise<PostResult> {
  const response = await fetch(POSTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": linkedinVersion,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      author: token.personUrn,
      commentary,
      visibility,
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new LinkedInError(`Post failed (${response.status})`, response.status, text);
  }

  // 201 Created. The new post's URN comes back in a header, not the body.
  const urn = response.headers.get("x-restli-id") ?? "";
  return { urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : "" };
}
