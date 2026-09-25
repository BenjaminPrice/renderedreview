# Deploying the marketing site

The marketing site at `renderedreview.com` is `apps/site`: an [Astro](https://astro.build) project built to static HTML, CSS and a little JavaScript, and served by Cloudflare as Workers static assets. The app itself stays on `renderedreview.dev` (see [deploy-cloudflare.md](deploy-cloudflare.md)).

## Why Workers static assets

The app already deploys as a Cloudflare Worker with `wrangler deploy` from a manual GitHub workflow. The site uses the same account, tooling and workflow shape. Cloudflare now recommends Workers static assets over Pages for new projects, and an assets-only Worker (no `main` script) serves files at no Worker invocation cost. It reads `_headers` for response headers and serves the built `404.html` for unknown paths.

## How it is built

- `pnpm --filter @rendered-review/site build` writes the site to `apps/site/dist`. `pnpm --filter @rendered-review/site dev` runs the Astro dev server.
- `pnpm --filter @rendered-review/site test` builds the site, then checks the output: every internal link and anchor resolves, the prices match `apps/site/src/pricing.ts`, each page has its title, description, canonical URL and Open Graph tags, the markup has no inline scripts, styles or event handlers, the hero video needs JavaScript and a wide screen to load, and axe finds no violations.
- `pnpm --filter @rendered-review/site preview` serves the built `dist` with `wrangler dev`, including the headers from `public/_headers`.
- Prices live in one place, `apps/site/src/pricing.ts`. Change them there; its unit test holds the published numbers.
- Styles come from `@rendered-review/design-tokens`, shared with the app.

### Security headers

`apps/site/public/_headers` sets a strict Content Security Policy: scripts, styles and media from the site itself only, no inline script or style, no framing. The build keeps every stylesheet and script in its own file (`build.inlineStylesheets: "never"`, no asset inlining), and the site test fails if a page gains an inline `<script>`, `<style>`, `style` attribute or `on*` handler.

### JavaScript

Pages work without JavaScript. Three small scripts add to them:

- `public/theme.js` (blocking, in `<head>`): applies a saved light/dark choice before first paint, handles the theme button, and marks the page as scripted. Without it the OS preference applies and the button is hidden.
- `src/scripts/hero-video.ts`: loads the hero video only at 900px and wider, picks the light or dark rendition, and drives the Pause/Play button. With reduced motion the video waits for Play. Phones and pages without JavaScript get the static product preview and download no video.
- The monthly/annual pricing switch is two radio buttons and CSS; it needs no script.

### The hero video

`apps/site/public/video/` holds the rendered hero video (`hero.{webm,mp4}`, `hero-dark.{webm,mp4}`) and poster frames. They were rendered with [Remotion](https://www.remotion.dev) from a composition that draws the same markup and design tokens as the site's product preview; the Remotion project is not part of this repository and the site does not ship Remotion. Remotion's license is free for individuals and small companies; check [remotion.pro](https://www.remotion.pro) before re-rendering commercially.

## Environments

`apps/site/wrangler.jsonc` defines:

| Environment  | Worker name                    | Serves on                                            |
| ------------ | ------------------------------ | ---------------------------------------------------- |
| top level    | `rendered-review-site-local`   | `wrangler dev` only                                  |
| `preview`    | `rendered-review-site-preview` | `rendered-review-site-preview.<account>.workers.dev` |
| `production` | `rendered-review-site`         | `renderedreview.com` (custom domain)                 |

## Deploying

Deploys run only from the **Deploy site** workflow (`.github/workflows/deploy-site.yml`, **Actions → Deploy site → Run workflow**). It runs the site checks, builds, and runs `wrangler deploy --env <environment>`. Production deploys only from `main`.

## One-time setup

1. **Cloudflare API token.** The app's deploy token can be reused if it covers the `renderedreview.com` zone. Otherwise create one (**My Profile → API Tokens**, "Edit Cloudflare Workers" template) with the account and, under **Zone Resources**, the `renderedreview.com` zone, so deploys can attach the custom domain.
2. **GitHub environments.** The app's `preview` and `production` environments (**Settings → Environments**) already hold `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the site workflow uses the same ones. `production` should keep its required reviewers and its restriction to `main`.
3. **Domain.** Add the `renderedreview.com` zone to the same Cloudflare account (**Add a domain**) and point the registrar's nameservers at Cloudflare. Wait until the zone is active.
4. **Deploy preview**, open the `workers.dev` address, and check the pages and headers (`curl -I`).
5. **Deploy production.** The production environment's `routes` entry (`{ "pattern": "renderedreview.com", "custom_domain": true }`) makes `wrangler deploy` create the DNS record and certificate for the apex domain. If the token lacks zone access, add it in the dashboard instead: **Workers & Pages → rendered-review-site → Settings → Domains & Routes → Add → Custom domain**, `renderedreview.com`.
6. **www (optional).** To send `www.renderedreview.com` to the apex, add a proxied DNS record for `www` and a Redirect Rule (**Rules → Redirect Rules**, "Redirect from WWW to root" template, 301, preserve path and query).

## Rolling back

**Workers & Pages → rendered-review-site → Deployments** lists earlier versions; pick one and **Rollback**. Or re-run the workflow from an earlier commit (preview only; production deploys from `main`).
