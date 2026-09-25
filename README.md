# Rendered Review

Rendered Review is an optional interface for reviewing the Markdown documents in a GitHub pull request (RFCs, ADRs, design docs, guides) as rendered content. You select text in the rendered document and comment on it in place. GitHub stays the authoritative system for files, comments, suggestions, permissions and history: published feedback is stored as native GitHub review comments where possible, and as readable PR conversation comments otherwise. It runs as a hosted service on Cloudflare Workers or self-hosted as a Node server.

## Prerequisites

- [devbox](https://www.jetify.com/devbox)
- [direnv](https://direnv.net/) ([hooked into your shell](https://direnv.net/docs/hook.html))

You don't need anything else installed globally. devbox pins Node.js, pnpm, wrangler, sqlite and the PostgreSQL client (see `devbox.json` / `devbox.lock`).

## Setup

```sh
git clone git@github.com:BenjaminPrice/renderedreview.git
cd renderedreview
direnv allow     # activates the devbox environment whenever you cd in
pnpm install
```

Put local secrets in `.env.local`. It is git-ignored, and `.envrc` loads it automatically. If you don't use direnv, run commands through `devbox shell` or `devbox run -- <cmd>`. Values must fit on one line; run `direnv reload` after editing it, which prints any parse error (a bad line can stop the whole file from loading).

The server refuses to start without a valid configuration. The smallest one is a public-only community instance:

```sh
# .env.local
HOSTING_MODE=community
ACCESS_POLICY=disabled
```

## Configuration

All builds read the same environment variables (`packages/runtime/src/config.ts`). Only what the chosen mode needs is required. Startup reports every problem at once and logs the effective configuration with secrets redacted. What the server logs, and what it never logs, is in [docs/observability.md](docs/observability.md).

| Variable                                                                                                                   | Required                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `HOSTING_MODE` (`hosted`, `dedicated`, `community`)                                                                        | Always                                                                                                                     |
| `ACCESS_POLICY` (`disabled`, `allowlist`, `installed`, `all-accessible`)                                                   | Defaults to `allowlist` in community, `installed` otherwise                                                                |
| `ACCESS_ALLOWLIST` (comma-separated `owner` or `owner/repo`)                                                               | When the policy is `allowlist`                                                                                             |
| `GITHUB_URL`                                                                                                               | Defaults to `https://github.com`; set it to a GitHub Enterprise Server URL                                                 |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | Hosted and dedicated; community unless the policy is `disabled`                                                            |
| `GITHUB_APP_PRIVATE_KEY_FILE` (path to the `.pem`)                                                                         | Node build: instead of `GITHUB_APP_PRIVATE_KEY`; set one, not both                                                         |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`                                                                     | Hosted; optional elsewhere                                                                                                 |
| `ENCRYPTION_KEY` (`openssl rand -base64 32`)                                                                               | Whenever GitHub credentials are set                                                                                        |
| `ENCRYPTION_KEY_PREVIOUS`                                                                                                  | Optional: the key being rotated out (see below)                                                                            |
| `BETTER_AUTH_SECRET` (`openssl rand -base64 32`)                                                                           | Whenever GitHub App credentials are set; signs sessions and OAuth state                                                    |
| `DATABASE_URL` (`postgres://…`, `sqlite:./relative.db`, `sqlite:///absolute.db`)                                           | Node build, when GitHub credentials are set or the mode is not `community`                                                 |
| `BILLING_PROVIDER` (`polar`, `stripe`), `BILLING_API_KEY`, `BILLING_WEBHOOK_SECRET`                                        | Hosted only; ignored otherwise                                                                                             |
| `PORT`                                                                                                                     | Node server listen port (default 3000)                                                                                     |
| `GITHUB_PUBLIC_READ_TOKEN`                                                                                                 | Optional, any mode; meant for local development and self-hosting (see below)                                               |
| `UPGRADE_URL` (URL, `/path`, or `none`)                                                                                    | Optional: where "See plans" points when a trial ends (default `https://renderedreview.com/pricing`); `none` hides the link |
| `TRUSTED_PROXY_HEADER` (such as `x-forwarded-for`, `x-real-ip`)                                                            | Node build behind a reverse proxy; see [Rate limits](#rate-limits)                                                         |
| `RATE_LIMIT_GUEST_PER_MINUTE`, `RATE_LIMIT_AUTH_PER_MINUTE`, `RATE_LIMIT_WRITES_PER_MINUTE`, `TRIAL_STARTS_PER_DAY`        | Optional; see [Rate limits](#rate-limits)                                                                                  |

### Public read token

Without sign-in, public pull requests are read anonymously, which GitHub limits to 60 requests an hour per IP address. Set `GITHUB_PUBLIC_READ_TOKEN` to have the server read public repositories with your token instead (5,000 requests an hour). Browsers then send public reads through the server's `/api/github/public/` proxy; the token never leaves the server and is redacted from logs.

Use a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Public repositories (read-only)** access, or a classic token with no scopes. The token only goes to the host in `GITHUB_URL`. Because a token may be able to read private repositories, the proxy first checks that each repository is public (cached for a few minutes) and answers "not found" for private, internal or unverifiable repositories.

### Rate limits

The server limits how fast one client can use it. Over a limit, it answers `429` with a `Retry-After` header and `{ "code": "rate-limited", "message": "…", "retryAfter": <seconds> }`, and logs a `rate.limited` event naming the limit (never the address or user).

| Limit                                             | Counted per                          | Variable (default)                  |
| ------------------------------------------------- | ------------------------------------ | ----------------------------------- |
| Guest reads through `/api/github/public/`         | Client address, per minute           | `RATE_LIMIT_GUEST_PER_MINUTE` (120) |
| Sign-in and linking starts, and their callbacks   | Client address, per minute           | `RATE_LIMIT_AUTH_PER_MINUTE` (20)   |
| Publishing (a review counts one per draft)        | Signed-in user, per minute           | `RATE_LIMIT_WRITES_PER_MINUTE` (60) |
| Starting a private-repository trial (hosted mode) | User and client address, per UTC day | `TRIAL_STARTS_PER_DAY` (3)          |

Client addresses are only used as an HMAC under a key derived from `BETTER_AUTH_SECRET` (a random per-process key without it), so no counter or log holds one. The per-minute counters live in memory: each instance counts on its own, so running several multiplies the limits. Trial starts are counted in the database (`usage_counter`), which every instance shares.

On Node the client address is the connection's peer address. Behind a reverse proxy that is the proxy itself, so every client would share one budget: set `TRUSTED_PROXY_HEADER` to the header your proxy sets, and the server takes its **right-most** value, the hop your proxy appended (`X-Forwarded-For` with nginx `$proxy_add_x_forwarded_for`, Caddy or Traefik) or set (`X-Real-IP`). Values a client sends are to the left of it and are ignored. This assumes exactly one proxy in front of the server; with a chain (for example a CDN in front of nginx), use a header the outermost proxy sets and the inner one passes unchanged, such as `CF-Connecting-IP` behind Cloudflare. Only set it when a proxy is always in front: otherwise clients can choose their own address. Without the header on a request, the peer address is used.

On Cloudflare Workers the address is always `CF-Connecting-IP` and `TRUSTED_PROXY_HEADER` is ignored; the guest and sign-in limits come from the Rate Limiting bindings in `apps/web/wrangler.jsonc` (see [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md#rate-limits)).

### Sign in with GitHub

Sign-in uses the GitHub App's user authorization: `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` drive the flow, and the app's expiring user-to-server tokens are what the server keeps. It is on when the GitHub App credentials, `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and a database are configured and `GITHUB_URL` is github.com (Enterprise Server sign-in is not supported yet). Otherwise the top bar shows no sign-in and every `/api/auth/*` route answers 404.

In the GitHub App settings, set the callback URL to `<public origin>/api/auth/callback/github` (for local development `http://localhost:3000/api/auth/callback/github`) and enable **Expire user authorization tokens**. Give the app the **Email addresses** account permission (read) if you want users' email addresses; without it, accounts use GitHub's noreply address.

Webhooks: in the GitHub App's settings, set **Webhook URL** to `<public origin>/api/github/webhook`, set **Webhook secret** to the same value as `GITHUB_APP_WEBHOOK_SECRET` (`openssl rand -hex 32`), and turn **Active** on. The endpoint answers 404 until the server runs a version that includes it with all the GitHub App variables and a database configured, so GitHub's first ping (sent when you save) fails if the server isn't set up yet. Once it is, open the ping under the app's **Advanced → Recent Deliveries** and click **Redeliver**; it should answer `200` (`401` means the two secrets differ). To turn webhooks on for an existing app, generate a new secret, set it in both places, then turn **Active** on and redeliver the ping. GitHub must be able to reach the URL; for local development, forward it with a tunnel such as smee.io, or leave the webhook inactive. Each delivery's signature is checked before anything else, and a delivery that was already processed is answered without running again. Subscribe the app to the **Repository** event (installation events need no subscription). The server records where the app is installed from these deliveries and uses that to pick a write credential without calling GitHub each time. For owners it has no record of (for example, installed while the webhook was inactive), it asks GitHub instead.

Set the GitHub App's **Setup URL** to `<public origin>/api/github/setup` and turn on **Redirect on update**. When someone installs the app from a pull request's "install the Rendered Review GitHub App" link, GitHub then sends them back to that pull request. The Setup URL is ignored while **Request user authorization (OAuth) during installation** is on, so leave that off.

A local `.env.local` with sign-in (generate `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` with `openssl rand -base64 32`):

```sh
HOSTING_MODE=community
ACCESS_POLICY=installed
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv23li...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_WEBHOOK_SECRET=...
GITHUB_APP_PRIVATE_KEY_FILE=.data/github-app.pem
ENCRYPTION_KEY=...
BETTER_AUTH_SECRET=...
DATABASE_URL=sqlite:./.data/rendered-review.db
```

Relative paths in `DATABASE_URL` and `GITHUB_APP_PRIVATE_KEY_FILE` resolve from the repository root (the directory with `pnpm-workspace.yaml`), or from the working directory when run outside a checkout. The SQLite file's directory is created on first start. `.data/` is git-ignored; keep the key file and database there. To put the key in the env file instead, set `GITHUB_APP_PRIVATE_KEY` on one line with `\n` for each line break (`awk 'NF {printf "%s\\n", $0}' key.pem` prints that form); a multi-line value breaks the env file.

The server must see the public origin in the request URL, because the OAuth redirect URI and cookie security follow it. Behind a TLS-terminating proxy, forward `Host` and configure the proxy so the Node server receives the public `https://` URL. Session cookies are `HttpOnly`, `SameSite=Lax` and `Secure` everywhere except `localhost`.

GitHub access and refresh tokens are encrypted with AES-256-GCM under `ENCRYPTION_KEY` before they reach the database, and are refreshed on the server shortly before they expire. They never go to the browser. To rotate the key, move the old value to `ENCRYPTION_KEY_PREVIOUS` and set a new `ENCRYPTION_KEY`. Existing rows still decrypt, and each is re-encrypted with the new key the next time its token is refreshed (at most eight hours for GitHub App tokens). Remove `ENCRYPTION_KEY_PREVIOUS` after that.

### Commenting on public repositories

A GitHub App's user token can only write where the app is installed. To let signed-in users comment on and review public pull requests in repositories without the app, register a GitHub **OAuth App** as well ([github.com/settings/applications/new](https://github.com/settings/applications/new), or under an organization's developer settings) and set `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`. Set its authorization callback URL to `<public origin>/api/auth/callback/github-public` (locally `http://localhost:3000/api/auth/callback/github-public`). It is optional in every mode except hosted, and does nothing without GitHub App sign-in.

Signed-in users then see **Allow commenting on public repositories** next to their name. It asks GitHub for the `public_repo` scope only (never `repo`) and links the grant to the account they signed in with; authorizing as a different GitHub user is refused. For each write the server uses the GitHub App token where the app is installed on the repository, and the OAuth App token on other public repositories. Private repositories without the app are not supported.

OAuth App tokens do not expire unless you enable expiring tokens in the OAuth App's settings (both work). A non-expiring token is never refreshed, so it stays encrypted under the key it was stored with: after a key rotation, users whose token was under the removed key are asked to allow public commenting again.

## Scripts

| Command                                            | What it does                                                    |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                                         | Start the web app dev server on :3000                           |
| `pnpm build`                                       | Build every package that has a `build` script                   |
| `pnpm --filter @rendered-review/web start`         | Run the built Node server (`/health` for probes)                |
| `pnpm --filter @rendered-review/web smoke`         | Check the built server answers `/health` on `PORT`              |
| `pnpm --filter @rendered-review/web dev:workers`   | Dev server running the app in local workerd                     |
| `pnpm --filter @rendered-review/web build:workers` | Build the Cloudflare Worker (`apps/web/dist`)                   |
| `pnpm --filter @rendered-review/web smoke:workers` | Serve the built Worker with `wrangler dev` and check its routes |
| `pnpm test`                                        | Run Vitest across all packages                                  |
| `pnpm lint`                                        | Run ESLint, including the domain boundary rule                  |
| `pnpm typecheck`                                   | Run `tsc --noEmit` at the root and every package                |
| `pnpm format`                                      | Format with Prettier (CI runs `format:check`)                   |

CI (`.github/workflows/ci.yml`) runs the same commands inside devbox.

The marketing site in `apps/site` builds and tests on its own (`pnpm --filter @rendered-review/site build|test`) and has its own CI and manual deploy workflows: [docs/deploy-site.md](docs/deploy-site.md).

On Cloudflare Workers, configuration comes from `vars` and secrets in `apps/web/wrangler.jsonc` instead of the process environment, and the database is the D1 binding `DB` rather than `DATABASE_URL`. Deploying and rolling back: [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md).

## Repository layout

```text
apps/web                        TanStack Start app (Router + Query)
apps/site                       Marketing site for renderedreview.com (Astro, static)
packages/review-domain          PR/file models, comment mapping, threads, re-anchoring
packages/markdown-domain        Parsing, sanitization, source mapping, selection
packages/diagram-domain         Fenced diagram registry and renderers
packages/annotation-domain      Annotation schemas, encoding, validation
packages/github-integration     GitHub API client, credential broker, webhooks
packages/identity               Better Auth, sessions, account linking
packages/control-plane          Billing, installations, plans, entitlements
packages/runtime                Runtime adapter interfaces, shared config loader
packages/runtime-node           Node adapters, startup config check, PostgreSQL/SQLite
packages/runtime-cloudflare     Workers adapters: bindings, D1, waitUntil
packages/github-action          PR discovery GitHub Action
```

Packages are named `@rendered-review/<dir>`. Each one exports its TypeScript source directly (`"exports": "./src/index.ts"`), so there is no per-package build step. Tests live next to the source as `*.test.ts`. To add a package, copy an existing `packages/*` directory and rename it.

### Domain boundary

The four `*-domain` packages and `runtime` must run in a browser. They can use Web Platform APIs and narrow interfaces only. Two checks enforce this:

- `eslint.config.ts` blocks imports of Node built-ins, `cloudflare:*` / `@cloudflare/*`, database drivers, Better Auth, and the runtime, identity and control-plane packages. `eslint.config.test.ts` shows the rule firing.
- `tsconfig.base.json` sets `"types": []`, so Node globals and dynamic `import("node:*")` calls fail typecheck.

## License

[AGPL-3.0-only](LICENSE)
