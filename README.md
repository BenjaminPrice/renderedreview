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

Put local secrets in `.env.local`. It is git-ignored, and `.envrc` loads it automatically. If you don't use direnv, run commands through `devbox shell` or `devbox run -- <cmd>`.

The server refuses to start without a valid configuration. The smallest one is a public-only community instance:

```sh
# .env.local
HOSTING_MODE=community
ACCESS_POLICY=disabled
```

## Configuration

All builds read the same environment variables (`packages/runtime/src/config.ts`). Only what the chosen mode needs is required. Startup reports every problem at once and logs the effective configuration with secrets redacted.

| Variable                                                                                                                   | Required                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `HOSTING_MODE` (`hosted`, `dedicated`, `community`)                                                                        | Always                                                                     |
| `ACCESS_POLICY` (`disabled`, `allowlist`, `installed`, `all-accessible`)                                                   | Defaults to `allowlist` in community, `installed` otherwise                |
| `ACCESS_ALLOWLIST` (comma-separated `owner` or `owner/repo`)                                                               | When the policy is `allowlist`                                             |
| `GITHUB_URL`                                                                                                               | Defaults to `https://github.com`; set it to a GitHub Enterprise Server URL |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | Hosted and dedicated; community unless the policy is `disabled`            |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`                                                                     | Hosted; optional elsewhere                                                 |
| `ENCRYPTION_KEY` (`openssl rand -base64 32`)                                                                               | Whenever GitHub credentials are set                                        |
| `DATABASE_URL` (`postgres://`, `sqlite://`, `file://`)                                                                     | Node build, when GitHub credentials are set or the mode is not `community` |
| `BILLING_PROVIDER` (`polar`, `stripe`), `BILLING_API_KEY`, `BILLING_WEBHOOK_SECRET`                                        | Hosted only; ignored otherwise                                             |
| `PORT`                                                                                                                     | Node server listen port (default 3000)                                     |

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

On Cloudflare Workers, configuration comes from `vars` and secrets in `apps/web/wrangler.jsonc` instead of the process environment, and the database is the D1 binding `DB` rather than `DATABASE_URL`. Deploying and rolling back: [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md).

## Repository layout

```text
apps/web                        TanStack Start app (Router + Query)
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
