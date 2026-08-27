# linkedin-poster

Post to **your own** LinkedIn feed from Claude Code, a shell, or a cron job. One
Cloudflare Worker, no dependencies, three surfaces: an **MCP server** so an agent
can publish directly, an **HTTP API** for scripts, and a **voice linter** that
refuses to publish text carrying the tells of machine-written prose.

Built because a good post is worth automating and a bad em-dash is not worth
shipping. This README has no em-dashes in it either, which is the point.

```
Claude Code ──MCP──┐
                   ├──> Worker ──> LinkedIn Posts API ──> your feed
curl / CI ──HTTP───┘      │
                          └──> KV (one 60-day token) + daily cron reminder
```

## What it is not

This posts as **one member: you**. It is not a scheduling SaaS, not a
multi-tenant tool, and it does not touch anybody else's account. Everything it
needs is self-serve; no LinkedIn partner program is involved.

## The constraint that shapes everything

LinkedIn access tokens last **60 days**, and **programmatic refresh tokens are
limited to approved Marketing Developer Platform partners**. A self-serve app
never gets one. There is no way around this, and any guide promising
set-and-forget LinkedIn automation is wrong.

What there *is*: while your current token is still valid and you are logged into
LinkedIn, hitting the authorization endpoint again **skips the consent screen**
and just redirects. So renewal is one click every seven weeks, as long as you do
it before the token dies. Miss the window and you get the consent screen back,
which is two clicks instead of one.

That is why this service ships with a cron trigger. It counts the days down and
pings you at 14, 7, 3 and 1 days out, while silent renewal still works.

## Setup

### 1. LinkedIn side (manual, about ten minutes)

1. You need a **LinkedIn Page**. The developer portal makes you attach the app
   to one and have a page admin verify it.
2. Create the app at [linkedin.com/developers](https://www.linkedin.com/developers/apps).
   Note the **Client ID** and **Client Secret**.
3. **Products** tab, request both (they are Open Permissions and approve
   instantly):
   - *Sign In with LinkedIn using OpenID Connect* → `openid`, `profile`
   - *Share on LinkedIn* → `w_member_social`
4. **Auth** tab → add the redirect URL. It must be HTTPS, absolute, and match
   `REDIRECT_URI` character for character:
   `https://your-worker.example.com/auth/callback`

### 2. Worker side

```bash
git clone https://github.com/stepanic/linkedin-poster.git
cd linkedin-poster
npm install

# KV to hold the token
npx wrangler kv namespace create TOKENS
npx wrangler kv namespace create TOKENS --preview
# paste both ids into wrangler.jsonc

# edit wrangler.jsonc: name, routes, REDIRECT_URI, account_id

npx wrangler secret put LINKEDIN_CLIENT_ID
npx wrangler secret put LINKEDIN_CLIENT_SECRET
npx wrangler secret put API_TOKEN     # openssl rand -hex 32, guards /post and /mcp
npx wrangler secret put SETUP_KEY     # openssl rand -hex 32, guards /auth/start
npx wrangler secret put NOTIFY_WEBHOOK  # optional, any URL taking a JSON POST

npm run deploy
```

### 3. Connect your account

Open `https://your-worker.example.com/auth/start?key=<SETUP_KEY>` in a browser,
approve once, done. The page tells you the expiry date.

`SETUP_KEY` is not decoration. Without it, anyone who found the URL could bind
**their** LinkedIn account to your Worker and overwrite your stored token.

## Using it from Claude Code

```bash
claude mcp add --transport http linkedin https://your-worker.example.com/mcp \
  --header "Authorization: Bearer $API_TOKEN"
```

Three tools:

| Tool | What it does |
|---|---|
| `linkedin_post` | Lints, then publishes. Refuses on errors unless `force: true`. |
| `linkedin_check` | Lints without publishing. Use it while drafting. |
| `linkedin_status` | Who it posts as, and how many days the token has left. |

Then, in a session: *"check this draft against the linter, then post it."*

## Using it from a shell

```bash
# dry run: lint only, publish nothing
curl -s -X POST https://your-worker.example.com/post \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"…","dry_run":true}'

# publish
curl -s -X POST https://your-worker.example.com/post \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"…","visibility":"PUBLIC"}'

# token state
curl -s https://your-worker.example.com/status -H "Authorization: Bearer $API_TOKEN"
```

`/post` returns `201` with the post URN and its public URL, `422` when the linter
blocks it, `503` when the token is missing or dead.

## The linter

Errors block publishing; warnings do not.

| Rule | Severity | Why |
|---|---|---|
| `no-em-dash`, `no-en-dash` | error | The clearest tell of generated prose. A comma or a full stop always works. |
| `max-length` | error | LinkedIn rejects commentary over 3000 characters. |
| `empty` | error | Obvious, but easy to hit when piping from a file. |
| `no-markdown-bold`, `no-markdown-link`, `no-markdown-heading`, `markdown-bullets` | warning | LinkedIn renders none of it. Asterisks and hash marks show up literally. |

**Hyphens are never flagged.** `read-only tier`, `two-day sprint` and
`per-client limits` are correct and must stay. Only U+2014 and U+2013 are errors.

Editing `src/lint.ts` is the intended way to make this yours. The rules encode
one person's writing conventions, not a universal standard.

## Things that will surprise you

- **The Posts API does not scrape URLs, but LinkedIn still linkifies them.**
  Verified on a live post: a bare URL is shortened to `lnkd.in/...` and is
  clickable. What you do not get is the preview card with an image and title. For
  that you need a thumbnail uploaded through the Images API plus a
  `content.article` block. Not implemented here yet.
- **`LinkedIn-Version` is mandatory and versions get sunset.** `202508` went dark
  on 17 August 2026. Treat the value in `wrangler.jsonc` as a maintenance item.
- **`/v2/ugcPosts` is deprecated.** This uses `/rest/posts`, which replaced it.
- **Changing the requested scopes invalidates every existing token.** You will
  have to re-authorize.
- **150 requests per member per day.** Per member, not per app.

## Layout

| File | Contains |
|---|---|
| `src/index.ts` | Routes, OAuth flow, cron reminder |
| `src/linkedin.ts` | OAuth and Posts API calls, all endpoints in one place |
| `src/mcp.ts` | MCP server, hand-rolled JSON-RPC, stateless |
| `src/lint.ts` | The voice linter |
| `src/tokens.ts` | KV token record, expiry maths, timing-safe secret compare |

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in, never commit
npm run types                    # regenerate Env after editing wrangler.jsonc
npm run typecheck
npm run dev
```

`wrangler dev --local` gives you a local KV, so the whole flow short of the real
LinkedIn calls can be exercised without credentials.

## Notes from a real setup

[`docs/2026-08-27-postavljanje-i-zamke.md`](docs/2026-08-27-postavljanje-i-zamke.md)
records what setting this up from zero actually cost: the portal rejecting any app
name containing "LinkedIn", the irreversible Page association, OAuth scopes that
stay empty until you refresh the page, `%20` versus `+` in the scope parameter, a
negative DNS cache that made a working deployment look dead, and how secrets were
handled so none of them passed through a terminal.

## Licence

MIT. The rules in `src/lint.ts` are mine; the mechanism is yours to take.
