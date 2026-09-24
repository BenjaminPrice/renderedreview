// SPDX-License-Identifier: AGPL-3.0-only
// SqlDatabase over SQLite (Node's built-in node:sqlite) or PostgreSQL (postgres.js),
// chosen by the DATABASE_URL scheme.
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDatabase, SqlValue } from "@rendered-review/runtime";
import postgres from "postgres";

export interface NodeDatabase extends SqlDatabase {
  close(): Promise<void>;
}

/**
 * `postgres://` / `postgresql://` → PostgreSQL; `sqlite:` / `file:` → SQLite (`sqlite::memory:` for in-memory).
 * SQLite paths: `sqlite:///abs/app.db` or `sqlite:/abs/app.db` is absolute; `sqlite:./rel/app.db` or
 * `sqlite://rel/app.db` is relative (see resolveLocalPath). Missing parent directories are created.
 */
export function openDatabase(url: string): NodeDatabase {
  return /^postgres(ql)?:/.test(url) ? openPostgres(url) : openSqlite(url.replace(/^(sqlite|file):(\/\/)?/, ""));
}

/**
 * Resolves a relative local path (SQLite file, key file) against the pnpm workspace root, found by walking
 * up from `cwd` to `pnpm-workspace.yaml`, so it means the same under `pnpm dev` (cwd `apps/web`) and from
 * the repository root. Outside a checkout (a deployed build) it resolves against `cwd`.
 */
export function resolveLocalPath(path: string, cwd = process.cwd()): string {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return resolve(dir, path);
    if (dir === dirname(dir)) return resolve(cwd, path);
  }
}

function openSqlite(path: string): NodeDatabase {
  if (path !== ":memory:") {
    path = resolveLocalPath(path);
    // The file holds encrypted tokens and sessions: whatever we create is owner-only (mode is ignored
    // on Windows). Existing directories and files keep their permissions. The default rollback journal
    // (`-journal`) inherits the database file's mode; no WAL sidecars since WAL is not enabled.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  }
  const db = new DatabaseSync(path);
  // SQLite leaves foreign keys off by default; D1 and PostgreSQL enforce them.
  db.exec("PRAGMA foreign_keys = ON");
  const bind = (params: readonly SqlValue[]) => params as SQLInputValue[];
  return {
    all: async <Row>(sql: string, params: readonly SqlValue[] = []) => db.prepare(sql).all(...bind(params)) as Row[],
    run: async (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...bind(params)).changes) }),
    close: async () => db.close(),
  };
}

function openPostgres(url: string): NodeDatabase {
  const sql = postgres(url, {
    // int8 (count(*), BIGINT) arrives as a string by default; return numbers like SQLite and D1 do.
    types: { bigint: { to: 20, from: [20], serialize: String, parse: Number } },
    onnotice: () => {},
  });
  const query = (text: string, params: readonly SqlValue[]) =>
    sql.unsafe(toPostgresPlaceholders(text), params as postgres.ParameterOrJSON<never>[]);
  return {
    all: async <Row>(text: string, params: readonly SqlValue[] = []) => [...(await query(text, params))] as Row[],
    run: async (text, params = []) => ({ changes: (await query(text, params)).count }),
    close: () => sql.end(),
  };
}

/** Rewrites `?` placeholders to `$1, $2, …`, leaving `?` inside quoted strings and identifiers alone. */
export function toPostgresPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?/g, (match) => (match === "?" ? `$${++n}` : match));
}
