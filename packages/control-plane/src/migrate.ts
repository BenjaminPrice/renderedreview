// SPDX-License-Identifier: AGPL-3.0-only
// Applies the numbered SQL files in ../migrations through the portable SqlDatabase interface.
// On Cloudflare D1, `wrangler d1 migrations apply` applies the same files instead.
/// <reference types="vite/client" />
import type { SqlDatabase } from "@rendered-review/runtime";

export interface Migration {
  /** File name without extension, e.g. `0001_initial`. Applied in name order. */
  name: string;
  sql: string;
}

// Bundled at build time, so the Node server and Workers need no filesystem access.
const files = import.meta.glob<string>("../migrations/*.sql", { query: "?raw", import: "default", eager: true });

export const migrations: Migration[] = Object.entries(files)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1, -".sql".length), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Splits a migration into statements: D1 and SQLite prepare one statement at a time.
 * Migrations must end each statement with `;` at the end of a line and must not put `;`
 * at a line end inside a statement (no triggers or function bodies).
 */
export function splitStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Applies pending migrations in order and returns the names applied. */
export async function migrate(db: SqlDatabase, pending: readonly Migration[] = migrations): Promise<string[]> {
  await db.run("CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set((await db.all<{ name: string }>("SELECT name FROM schema_migration")).map((row) => row.name));
  const applied: string[] = [];
  for (const migration of pending) {
    if (done.has(migration.name)) continue;
    // ponytail: no transaction (D1 has none through this interface), so a failed migration
    // leaves earlier statements applied and must be repaired by hand; keep migrations small.
    for (const statement of splitStatements(migration.sql)) await db.run(statement);
    await db.run("INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)", [
      migration.name,
      new Date().toISOString(),
    ]);
    applied.push(migration.name);
  }
  return applied;
}
