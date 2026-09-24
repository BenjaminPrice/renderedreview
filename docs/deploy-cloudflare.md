# Deploying to Cloudflare Workers

Rendered Review has two server builds from the same source: a portable Node server (`pnpm build`) and a Cloudflare Worker (`pnpm --filter @rendered-review/web build:workers`). This guide covers the Worker. The hosted service at `renderedreview.dev` runs this build.

## How the Worker build works

- `apps/web/vite.config.ts` swaps Nitro for `@cloudflare/vite-plugin` in `--mode workers`. The plugin runs the server in local workerd during `dev:workers` and builds the Worker into `apps/web/dist` (`dist/client` holds static assets, including the service worker `sw.js`; `dist/server` holds the Worker and a flattened `wrangler.json`).
- The server entry `apps/web/src/server.ts` is shared by both builds. It imports `#runtime`, which `apps/web/package.json` resolves to `@rendered-review/runtime-cloudflare` under the `workerd` condition and to `@rendered-review/runtime-node` otherwise.
- `@rendered-review/runtime-cloudflare` reads configuration and secrets from the Worker's `env` (via `cloudflare:workers`), hands background work to `waitUntil`, and adapts the D1 binding to the `SqlDatabase` interface.
- Node.js compatibility is on by default for the configured compatibility date and is required by the framework (TanStack Router's SSR imports `node:stream`; Start uses `AsyncLocalStorage`). Application code uses Web APIs only.

## Configuration

`apps/web/wrangler.jsonc` defines three environments:

| Environment | Selected by                 | Worker name               | D1 database                  | URL                                                     |
| ----------- | --------------------------- | ------------------------- | ---------------------------- | ------------------------------------------------------- |
| local       | default                     | `rendered-review`         | local file in `.wrangler/`   | `http://localhost:3000` (`dev:workers`)                 |
| preview     | `CLOUDFLARE_ENV=preview`    | `rendered-review-preview` | `rendered-review-preview`    | `https://rendered-review-preview.<account>.workers.dev` |
| production  | `CLOUDFLARE_ENV=production` | `rendered-review`         | `rendered-review-production` | `https://renderedreview.dev`                            |

The environment is chosen at **build** time. `wrangler deploy` then deploys whatever the last build produced (the build writes `apps/web/.wrangler/deploy/config.json` pointing at `dist/server/wrangler.json`), so it takes no `--env` flag.

Configuration variables are the same ones the Node build reads (see the README). Non-secret values go in each environment's `vars`; secrets are set per environment:

```sh
cd apps/web
pnpm exec wrangler secret put ENCRYPTION_KEY --env production
```

For local development, put secrets in `apps/web/.dev.vars` (git-ignored), one `NAME=value` per line.

Both hosted environments serve public pull requests only (`HOSTING_MODE=community`, `ACCESS_POLICY=disabled`); neither needs a billing account. Preview needs no secrets. Production also offers GitHub sign-in (see [Enable GitHub sign-in](#enable-github-sign-in)), so its `secrets.required` lists the seven sign-in secrets and `wrangler deploy` refuses to run while one of them is unset. `wrangler deploy --dry-run` does not check them. Moving to `HOSTING_MODE=hosted` (private repositories) also needs the OAuth and billing secrets listed at the top of `wrangler.jsonc`; add them to `secrets.required` at that point.

## One-time setup

Nothing here is automated; each step needs a Cloudflare account.

1. Create the databases and paste each printed `database_id` into the matching environment's `d1_databases` entry in `apps/web/wrangler.jsonc` (replacing the all-zero placeholder), then commit the change. Database IDs are not secrets, and the deploy workflow reads the committed file. If `wrangler d1 create` offers to add the database to your configuration, decline: it appends a top-level entry with a different binding name instead of filling in the environment.

   ```sh
   cd apps/web
   pnpm exec wrangler login
   pnpm exec wrangler d1 create rendered-review-preview
   pnpm exec wrangler d1 create rendered-review-production
   ```

2. Create an API token (Cloudflare dashboard, **My Profile → API Tokens**, "Edit Cloudflare Workers" template, plus **D1: Edit**) scoped to the account.
3. In the GitHub repository, create the environments `preview` and `production` (**Settings → Environments**). Give `production` required reviewers and restrict it to the `main` branch. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets on both.
4. Deploy `preview` once (below) and check it.
5. Custom domain (manual): add the `renderedreview.dev` zone to the same Cloudflare account, deploy `production` once, then in the dashboard open **Workers & Pages → rendered-review → Settings → Domains & Routes → Add → Custom domain** and enter `renderedreview.dev`. Cloudflare creates the DNS record and certificate. (Alternatively add `"routes": [{ "pattern": "renderedreview.dev", "custom_domain": true }]` to the production environment so deploys manage it.)

## Enable GitHub sign-in

Signed-in readers use their own GitHub token: 5,000 requests an hour instead of the shared anonymous limit, and real resolved/unresolved thread state. The site still serves public pull requests only. Sign-in turns on when the GitHub App credentials, `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and the D1 binding are all present, and it needs no config change beyond the secrets. Production is set up this way; preview has no sign-in.

1. Attach the custom domain first (one-time setup, step 5), because the callback URL uses it.
2. Create a GitHub App for production at <https://github.com/settings/apps/new>. Keep it separate from any app you use for local development, so keys, secrets and rate limits stay isolated.
   - **GitHub App name:** `Rendered Review`. **Homepage URL:** `https://<domain>`.
   - **Callback URL:** `https://<domain>/api/auth/callback/github`. You can add more, for example the `workers.dev` URL.
   - **Expire user authorization tokens:** on. **Request user authorization (OAuth) during installation:** off.
   - **Webhook:** turn off **Active**. Nothing receives webhooks yet.
   - **Repository permissions:** Contents, Issues, Metadata and Pull requests, all **Read-only**. **Account permissions:** Email addresses, **Read-only**.
   - **Where can this GitHub App be installed?** Start with **Only on this account**.
   - After creating the app, generate a client secret and a private key (a `.pem` download).
3. Set the Worker secrets for production. Cloudflare stores them encrypted and they are never committed. Run these from `apps/web`; each one prompts for its value:

   ```sh
   pnpm exec wrangler secret put GITHUB_APP_ID --env production             # App ID from the app's page
   pnpm exec wrangler secret put GITHUB_APP_CLIENT_ID --env production      # Client ID
   pnpm exec wrangler secret put GITHUB_APP_CLIENT_SECRET --env production  # the client secret
   pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY --env production    # contents of the .pem
   pnpm exec wrangler secret put GITHUB_APP_WEBHOOK_SECRET --env production # openssl rand -hex 32
   pnpm exec wrangler secret put ENCRYPTION_KEY --env production            # openssl rand -base64 32
   pnpm exec wrangler secret put BETTER_AUTH_SECRET --env production        # openssl rand -base64 32
   ```

   - Generate fresh values. Never reuse the ones from a development `.env.local`.
   - Keep a backup of `ENCRYPTION_KEY` somewhere safe, such as a password manager. It encrypts the stored GitHub tokens, so losing or changing it signs everyone out.
   - Workers can't read files, so `GITHUB_APP_PRIVATE_KEY_FILE` doesn't work here. Paste the whole PEM, with its real line breaks, for example `pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY --env production < key.pem`. A one-line value with literal `\n` also works.

4. Secrets apply to the running Worker right away. Later deploys keep them, and a deploy fails if one is missing.
5. Verify on `https://<domain>`:
   - Signing in from a pull request brings you back to the same pull request, and your avatar shows.
   - `/api/github/user/...` responses (browser devtools) carry `x-ratelimit-limit: 5000`.
   - Signing out works.
   - A second GitHub account can sign in. An app installable **Only on this account** may refuse other users. If it does, switch it to **Any account** under the app's **Advanced → Make public**. Private repositories need that later anyway.

`pnpm --filter @rendered-review/web smoke:workers` checks the same wiring locally. It runs the built Worker with fake app credentials and a throwaway local D1, then checks that `/api/auth/viewer` answers and sign-in redirects to GitHub with the right callback URL.

## Enable commenting on public repositories

The GitHub App's user tokens can only write where the app is installed. For public repositories without it, signed-in users link a separate OAuth App that has the `public_repo` scope and nothing broader. This is optional. Without it, commenting works only where the app is installed, and the Worker runs as before.

1. Register an OAuth App for production at <https://github.com/settings/applications/new>, separate from the one you use for local development.
   - **Application name:** `Rendered Review`. **Homepage URL:** `https://<domain>`.
   - **Authorization callback URL:** `https://<domain>/api/auth/callback/github-public`. OAuth Apps take a single callback URL.
   - Leave **Enable Device Flow** off. After registering, generate a client secret.
2. Set the Worker secrets (from `apps/web`):

   ```sh
   pnpm exec wrangler secret put GITHUB_OAUTH_CLIENT_ID --env production      # Client ID
   pnpm exec wrangler secret put GITHUB_OAUTH_CLIENT_SECRET --env production  # the client secret
   ```

3. Then add `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` to production's `secrets.required` in `wrangler.jsonc` (and the expected list in `apps/web/src/wrangler-config.test.ts`). Deploys then fail if they go missing. Don't add them before the secrets exist, or every production deploy is refused.
4. Verify on `https://<domain>`: once you're signed in, **Allow commenting on public repositories** appears next to your name. It goes to GitHub, asks only for public repository access, and brings you back to the same page, where the action is gone.

## Deploying

Deploys are manual. Run the **Deploy to Cloudflare** workflow (`.github/workflows/deploy-cloudflare.yml`) from the Actions tab and choose `preview` or `production`. Production only deploys from `main`. The workflow:

1. Installs dependencies and runs the tests.
2. Builds the Worker for the chosen environment.
3. Applies D1 migrations (`wrangler d1 migrations apply DB --remote`) from `packages/control-plane/migrations`.
4. Runs `wrangler deploy`.

From a workstation, the equivalent is:

```sh
CLOUDFLARE_ENV=preview pnpm --filter @rendered-review/web build:workers
cd apps/web && pnpm exec wrangler deploy
```

Check a deploy with `curl https://<host>/health` (expects `{"status":"ok"}`) and by opening a public pull request link, for example `https://<host>/github.com/<owner>/<repo>/pull/<number>`.

## Rollback

Cloudflare keeps previous Worker versions, so rolling back the code does not need a rebuild.

1. List recent versions and pick the last good one:

   ```sh
   cd apps/web
   pnpm exec wrangler deployments list --name rendered-review
   ```

2. Roll back (omit the version ID to go back to the previous version):

   ```sh
   pnpm exec wrangler rollback <version-id> --name rendered-review --message "Roll back: <reason>"
   ```

   For preview use `--name rendered-review-preview`. The same is available in the dashboard under **Workers & Pages → rendered-review → Deployments**.

3. Verify `/health` and a public PR link, then fix forward on `main` and redeploy through the workflow.

Rollback restores code and `vars` but not secrets, which are shared across versions; a rollback can fail if the old version expects a binding that no longer exists.

**Database changes.** A Worker rollback does not undo D1 migrations. Write migrations so the previous Worker version still works against the new schema (add columns and tables; drop them in a later release). If data must be restored, D1 Time Travel restores a database to any point in the last 30 days:

```sh
pnpm exec wrangler d1 time-travel info rendered-review-production
pnpm exec wrangler d1 time-travel restore rendered-review-production --timestamp=2026-01-01T12:00:00Z
```

A restore overwrites the database in place and prints a bookmark that can undo it.
