// SPDX-License-Identifier: AGPL-3.0-only
// SqlDatabase over SQLite (Node's built-in node:sqlite) or PostgreSQL (postgres.js),
// chosen by the DATABASE_URL scheme.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDatabase, SqlValue } from "@rendered-review/runtime";
import postgres from "postgres";

export interface NodeDatabase extends SqlDatabase {
  close(): Promise<void>;
}

/** `postgres://` / `postgresql://` → PostgreSQL; `sqlite:` / `file:` → SQLite file (`sqlite::memory:` for in-memory). */
export function openDatabase(url: string): NodeDatabase {
  return /^postgres(ql)?:/.test(url) ? openPostgres(url) : openSqlite(url.replace(/^(sqlite|file):(\/\/)?/, ""));
}

function openSqlite(path: string): NodeDatabase {
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
