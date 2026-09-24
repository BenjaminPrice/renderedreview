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

The hosted environments start in public-only mode (`HOSTING_MODE=community`, `ACCESS_POLICY=disabled`): public pull requests render, nothing needs a GitHub App or billing account. Moving to `HOSTING_MODE=hosted` requires the GitHub App, OAuth, encryption and billing secrets listed at the top of `wrangler.jsonc`; add them to that environment's `secrets.required` so a deploy refuses to run while one is missing.

## One-time setup

Nothing here is automated; each step needs a Cloudflare account.

1. Create the databases and paste each printed `database_id` into the matching environment in `apps/web/wrangler.jsonc` (replacing the all-zero placeholder):

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
