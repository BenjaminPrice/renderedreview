// SPDX-License-Identifier: AGPL-3.0-only
import { sqlDatabaseContract } from "@rendered-review/control-plane/contract";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, resolveLocalPath, toPostgresPlaceholders } from "./database";

sqlDatabaseContract("SQLite", async () => {
  const db = openDatabase("sqlite::memory:");
  return { db, dialect: "sqlite", close: () => db.close() };
});

// PostgreSQL needs a server: CI provides one; locally set TEST_POSTGRES_URL to run it.
const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl || process.env.CI) {
  sqlDatabaseContract("PostgreSQL", async () => {
    if (!postgresUrl) throw new Error("TEST_POSTGRES_URL is required in CI");
    // Each run gets its own schema, so the test never touches existing tables.
    const schema = `rr_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = openDatabase(postgresUrl);
    await admin.run(`CREATE SCHEMA ${schema}`);
    const url = new URL(postgresUrl);
    url.searchParams.set("search_path", schema);
    const db = openDatabase(url.toString());
    return {
      db,
      dialect: "postgres",
      close: async () => {
        await db.close();
        await admin.run(`DROP SCHEMA ${schema} CASCADE`);
        await admin.close();
      },
    };
  });
}

describe("toPostgresPlaceholders", () => {
  it("numbers ? outside quoted strings and identifiers", () => {
    expect(toPostgresPlaceholders(`SELECT '?', 'it''s ?', "a?" FROM t WHERE a = ? AND b IN (?, ?)`)).toBe(
      `SELECT '?', 'it''s ?', "a?" FROM t WHERE a = $1 AND b IN ($2, $3)`,
    );
  });
});

describe("openDatabase", () => {
  it("opens SQLite from sqlite: and file: URLs", async () => {
    for (const url of ["sqlite::memory:", "file::memory:"]) {
      const db = openDatabase(url);
      expect(await db.all("SELECT 1 AS one")).toEqual([{ one: 1 }]);
      await db.close();
    }
  });

  it("creates missing parent directories for a SQLite file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-db-"));
    for (const url of [`sqlite://${dir}/a/b/one.db`, `sqlite:${dir}/c/two.db`, `file://${dir}/d/three.db`]) {
      const db = openDatabase(url);
      expect(await db.all("SELECT 1 AS one")).toEqual([{ one: 1 }]);
      await db.close();
    }
  });
});

describe("resolveLocalPath", () => {
  it("resolves relative paths against the workspace root, from any directory inside it", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-root-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "");
    mkdirSync(join(root, "apps/web"), { recursive: true });
    for (const cwd of [root, join(root, "apps/web")]) {
      expect(resolveLocalPath("./.data/x.db", cwd)).toBe(join(root, ".data/x.db"));
    }
  });

  it("falls back to the working directory outside a workspace, and keeps absolute paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rr-cwd-"));
    expect(resolveLocalPath(".data/x.db", cwd)).toBe(join(cwd, ".data/x.db"));
    expect(resolveLocalPath("/abs/x.db", cwd)).toBe("/abs/x.db");
  });
});
