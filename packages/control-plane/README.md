# Control plane

Accounts, billing, GitHub installation associations, entitlements and aggregate counters. Everything here is operational metadata. Repository documents, comment and reply bodies, suggestions, review threads and annotations stay in GitHub and never get a table. The contract test fails if a table outside the allowlist or a content-like column shows up.

## Schema and migrations

`migrations/NNNN_name.sql` holds plain SQL, applied in file-name order. The same files run on all three databases:

- **Node (SQLite or PostgreSQL):** the Node runtime applies pending migrations on first use of `RequestContext.db` (`migrate()` in `src/migrate.ts`, tracked in `schema_migration`). The files are bundled into the server build, so no migrations directory has to ship.
- **Cloudflare D1:** use Wrangler. `apps/web/wrangler.jsonc` points every environment's `DB` binding (`migrations_dir`) at this directory; run `wrangler d1 migrations apply DB [--env <env>] --remote` (or `--local`) from `apps/web`. The deploy workflow does this before `wrangler deploy`. Wrangler tracks what it applied in its own `d1_migrations` table. Don't run both tools against the same D1 database.

To change the schema, add a new numbered file. Never edit an applied one.

## Portability rules

Every statement has to run unchanged on SQLite, D1 and PostgreSQL:

- **Types:** only `TEXT` and `INTEGER`. No `BOOLEAN`, `TIMESTAMP`, `JSON`, `SERIAL` or `AUTOINCREMENT`.
- **IDs:** `TEXT`. The application generates them. GitHub's numeric IDs are stored as decimal text in `github_id` / `github_user_id`, always together with `host`, so they stay exact past 2^53 and github.com and Enterprise Server IDs can't collide.
- **Timestamps:** ISO 8601 UTC text with milliseconds (`Date.prototype.toISOString()`, e.g. `2026-09-24T12:00:00.000Z`). Strings in this format sort in time order, so `<` / `>` / `ORDER BY` work everywhere. Columns have no database defaults: the application sets every timestamp.
- **Booleans:** `INTEGER` 0/1 with a `CHECK (x IN (0, 1))`.
- **Identifiers:** our tables use unquoted snake_case. The Better Auth tables keep Better Auth's default camelCase names, so they must be double-quoted (`"user"`, `"userId"`), because PostgreSQL folds unquoted names to lower case and reserves `user`.
- **Constraints:** declare foreign keys, `UNIQUE` and `CHECK` inline. The SQLite adapter turns on `PRAGMA foreign_keys`. D1 and PostgreSQL enforce foreign keys by default.
- **Upserts:** `INSERT … ON CONFLICT … DO NOTHING` / `DO UPDATE SET col = excluded.col` works on all three.
- **Statements:** end each one with `;` at the end of a line. The runner splits on that, because D1 and SQLite prepare one statement at a time. Don't use triggers, functions or anything else with line-ending `;` inside a statement. Comments go on their own `--` lines.
- **Queries** use `?` placeholders. The PostgreSQL adapter rewrites them to `$n`. PostgreSQL `bigint` results (such as `count(*)`) come back as numbers, as they do on SQLite and D1.
- **No transactions** through `SqlDatabase`, because D1 has none. A migration that fails halfway has to be repaired by hand, so keep migrations small.

## Better Auth

The `user`, `session`, `account` and `verification` tables match Better Auth's core schema, and this one migration system owns them. Better Auth's own CLI migrations aren't used. Because timestamps are text and booleans are integers, the Better Auth database adapter must be configured with `supportsDates: false` and `supportsBooleans: false` (Better Auth then writes ISO strings and 0/1). It must also quote identifiers. `account` token columns store application-encrypted ciphertext only.

## Contract tests

`src/contract.ts` exports `sqlDatabaseContract(name, open)`, the shared behavioral suite every `SqlDatabase` adapter runs:

- `packages/runtime-node/src/database.test.ts` covers SQLite and PostgreSQL. PostgreSQL runs when `TEST_POSTGRES_URL` is set, and is required in CI. Each run uses a throwaway schema.
- `packages/runtime-cloudflare/src/d1.contract.test.ts` covers the D1 adapter on a real local D1 (workerd via Miniflare).

To run the PostgreSQL contract locally, start a scratch server and set `TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:<port>/postgres`.
