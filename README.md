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

## Scripts

| Command          | What it does                                     |
| ---------------- | ------------------------------------------------ |
| `pnpm dev`       | Start the web app dev server on :3000            |
| `pnpm build`     | Build every package that has a `build` script    |
| `pnpm test`      | Run Vitest across all packages                   |
| `pnpm lint`      | Run ESLint, including the domain boundary rule   |
| `pnpm typecheck` | Run `tsc --noEmit` at the root and every package |
| `pnpm format`    | Format with Prettier (CI runs `format:check`)    |

CI (`.github/workflows/ci.yml`) runs the same commands inside devbox.

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
packages/runtime-node           Node HTTP server entry, PostgreSQL/SQLite
packages/runtime-cloudflare     Worker entry, D1, bindings
packages/github-action          PR discovery GitHub Action
```

Packages are named `@rendered-review/<dir>`. Each one exports its TypeScript source directly (`"exports": "./src/index.ts"`), so there is no per-package build step. Tests live next to the source as `*.test.ts`. To add a package, copy an existing `packages/*` directory and rename it.

### Domain boundary

The four `*-domain` packages must run in a browser. They can use Web Platform APIs and narrow interfaces only. Two checks enforce this:

- `eslint.config.ts` blocks imports of Node built-ins, `cloudflare:*` / `@cloudflare/*`, database drivers, Better Auth, and the runtime, identity and control-plane packages. `eslint.config.test.ts` shows the rule firing.
- `tsconfig.base.json` sets `"types": []`, so Node globals and dynamic `import("node:*")` calls fail typecheck.

## License

[AGPL-3.0-only](LICENSE)
