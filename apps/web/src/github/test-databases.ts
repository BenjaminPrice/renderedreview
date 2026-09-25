// SPDX-License-Identifier: AGPL-3.0-only
// Test helper: the control-plane databases to run database tests against. SQLite always; PostgreSQL
// when TEST_POSTGRES_URL is set, and required in CI. Each PostgreSQL run gets a throwaway schema.
import { openDatabase, type NodeDatabase } from "@rendered-review/runtime-node";

export type OpenTestDatabase = () => Promise<{ db: NodeDatabase; close: () => Promise<void> }>;

export const testDatabases: [string, OpenTestDatabase][] = [
  [
    "SQLite",
    async () => {
      const db = openDatabase("sqlite::memory:");
      return { db, close: () => db.close() };
    },
  ],
];
const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl || process.env.CI) {
  testDatabases.push([
    "PostgreSQL",
    async () => {
      if (!postgresUrl) throw new Error("TEST_POSTGRES_URL is required in CI");
      const schema = `rr_test_${crypto.randomUUID().replaceAll("-", "")}`;
      const admin = openDatabase(postgresUrl);
      await admin.run(`CREATE SCHEMA ${schema}`);
      const url = new URL(postgresUrl);
      url.searchParams.set("search_path", schema);
      const db = openDatabase(url.toString());
      return {
        db,
        close: async () => {
          await db.close();
          await admin.run(`DROP SCHEMA ${schema} CASCADE`);
          await admin.close();
        },
      };
    },
  ]);
}
