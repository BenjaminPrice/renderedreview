// SPDX-License-Identifier: AGPL-3.0-only
// Behavioral contract every SqlDatabase adapter must pass against the control-plane schema.
// Adapter packages call `sqlDatabaseContract` from their own tests (SQLite, PostgreSQL, D1).
import type { SqlDatabase } from "@rendered-review/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, migrations } from "./migrate";

/** Every table the schema may contain. Anything else fails the schema review. */
export const controlPlaneTables = [
  "account",
  "active_contributor",
  "billing_account",
  "entitlement",
  "github_installation",
  "github_installation_repository",
  "github_owner",
  "github_repository",
  "membership",
  "plan",
  "processed_webhook_event",
  "schema_migration",
  "session",
  "subscription",
  "trial",
  "usage_counter",
  "user",
  "verification",
];

// Words that would mean the control plane stores GitHub-owned content.
const contentWords = /body|content|comment|suggestion|thread|document|annotation|markdown|diff|patch|blob|file/i;

export interface ContractTarget {
  db: SqlDatabase;
  dialect: "sqlite" | "postgres";
  close?: () => Promise<void>;
}

export function sqlDatabaseContract(name: string, open: () => Promise<ContractTarget>) {
  describe(`${name} control-plane contract`, () => {
    let target: ContractTarget;
    let db: SqlDatabase;
    const now = "2026-09-24T12:00:00.000Z";

    beforeAll(async () => {
      target = await open();
      db = target.db;
    });
    afterAll(() => target?.close?.());

    it("applies every migration once", async () => {
      expect(await migrate(db)).toEqual(migrations.map((m) => m.name));
      expect(await migrate(db)).toEqual([]);
    });

    it("contains only control-plane tables and no content columns", async () => {
      const columns =
        target.dialect === "postgres"
          ? await db.all<{ table_name: string; column_name: string }>(
              "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()",
            )
          : await db.all<{ table_name: string; column_name: string }>(
              `SELECT m.name AS table_name, c.name AS column_name FROM sqlite_master m, pragma_table_info(m.name) c
               WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' AND m.name <> 'd1_migrations'`,
            );
      expect([...new Set(columns.map((c) => c.table_name))].sort()).toEqual(controlPlaneTables);
      expect(columns.filter((c) => contentWords.test(c.column_name))).toEqual([]);
    });

    it("round-trips text, integer and null values with ? placeholders", async () => {
      await db.run(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["u1", "Octo Cat", "octo@example.com", 1, null, now, now],
      );
      expect(
        await db.all(`SELECT "id", "emailVerified", "image", "createdAt" FROM "user" WHERE "email" = ?`, [
          "octo@example.com",
        ]),
      ).toEqual([{ id: "u1", emailVerified: 1, image: null, createdAt: now }]);
      // A literal ? is not a placeholder.
      expect(await db.all('SELECT \'?\' AS q, count(*) AS n FROM "user" WHERE "id" = ?', ["u1"])).toEqual([
        { q: "?", n: 1 },
      ]);
    });

    it("compares ISO timestamps in time order", async () => {
      await db.run(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
        [
          "s1",
          "2026-09-25T00:00:00.000Z",
          "t1",
          now,
          now,
          "u1",
          "s2",
          "2026-09-23T00:00:00.000Z",
          "t2",
          now,
          now,
          "u1",
        ],
      );
      expect(await db.all(`SELECT "id" FROM "session" WHERE "expiresAt" > ? ORDER BY "id"`, [now])).toEqual([
        { id: "s1" },
      ]);
    });

    it("reports affected rows", async () => {
      expect(await db.run(`UPDATE "session" SET "updatedAt" = ? WHERE "userId" = ?`, [now, "u1"])).toEqual({
        changes: 2,
      });
      expect(await db.run(`DELETE FROM "session" WHERE "id" = ?`, ["missing"])).toEqual({ changes: 0 });
    });

    it("enforces foreign keys and cascades deletes", async () => {
      await expect(
        db.run("INSERT INTO membership (billing_account_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
          "nope",
          "u1",
          "admin",
          now,
        ]),
      ).rejects.toThrow();
      await db.run(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
        ["u2", "Gone", "gone@example.com", 0, now, now],
      );
      await db.run(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)`,
        ["s3", now, "t3", now, now, "u2"],
      );
      await db.run(`DELETE FROM "user" WHERE "id" = ?`, ["u2"]);
      expect(await db.all(`SELECT "id" FROM "session" WHERE "userId" = ?`, ["u2"])).toEqual([]);
    });

    it("rejects check-constraint violations", async () => {
      await expect(
        db.run(
          "INSERT INTO github_owner (id, host, github_id, type, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ["o0", "github.com", "1", "Team", "acme", now, now],
        ),
      ).rejects.toThrow();
    });

    it("keys GitHub owners by host and stable ID, surviving renames", async () => {
      const insert =
        "INSERT INTO github_owner (id, host, github_id, type, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
      await db.run(insert, ["o1", "github.com", "9919", "Organization", "acme", now, now]);
      await db.run(insert, ["o2", "ghe.example.com", "9919", "Organization", "acme", now, now]);
      await expect(
        db.run(insert, ["o3", "github.com", "9919", "Organization", "acme-renamed", now, now]),
      ).rejects.toThrow();
      await db.run("UPDATE github_owner SET login = ? WHERE host = ? AND github_id = ?", [
        "acme-renamed",
        "github.com",
        "9919",
      ]);
      expect(
        await db.all("SELECT id, login FROM github_owner WHERE host = ? AND github_id = ?", ["github.com", "9919"]),
      ).toEqual([{ id: "o1", login: "acme-renamed" }]);
    });

    it("makes webhook deliveries and active contributors idempotent", async () => {
      const event =
        "INSERT INTO processed_webhook_event (source, delivery_id, processed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING";
      expect(await db.run(event, ["github", "d-1", now])).toEqual({ changes: 1 });
      expect(await db.run(event, ["github", "d-1", now])).toEqual({ changes: 0 });
      expect(await db.run(event, ["stripe", "d-1", now])).toEqual({ changes: 1 });

      await db.run("INSERT INTO billing_account (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [
        "b1",
        "Acme",
        now,
        now,
      ]);
      const contributor =
        "INSERT INTO active_contributor (billing_account_id, period_start, github_user_id, first_active_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING";
      expect(await db.run(contributor, ["b1", "2026-09-01T00:00:00.000Z", "583231", now])).toEqual({ changes: 1 });
      expect(await db.run(contributor, ["b1", "2026-09-01T00:00:00.000Z", "583231", now])).toEqual({ changes: 0 });
      expect(await db.all("SELECT count(*) AS n FROM active_contributor WHERE billing_account_id = ?", ["b1"])).toEqual(
        [{ n: 1 }],
      );
    });

    it("increments aggregate counters with an upsert", async () => {
      const bump = `INSERT INTO usage_counter (scope, subject, metric, window_start, count) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (scope, subject, metric, window_start) DO UPDATE SET count = usage_counter.count + excluded.count`;
      const key = ["user", "u1", "publish", "2026-09-24T12:00:00.000Z"];
      await db.run(bump, [...key, 1]);
      await db.run(bump, [...key, 2]);
      expect(await db.all("SELECT count FROM usage_counter WHERE subject = ?", ["u1"])).toEqual([{ count: 3 }]);
    });

    it("seeds the plan catalog", async () => {
      expect(
        await db.all("SELECT id, included_contributors FROM plan WHERE id IN (?, ?) ORDER BY id", [
          "enterprise",
          "team",
        ]),
      ).toEqual([
        { id: "enterprise", included_contributors: null },
        { id: "team", included_contributors: 10 },
      ]);
    });
  });
}
