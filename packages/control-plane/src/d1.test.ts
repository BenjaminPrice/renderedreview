// SPDX-License-Identifier: AGPL-3.0-only
// Runs the contract on a real local D1 (workerd's D1 implementation, via Miniflare).
// The thin binding below stands in for the Workers runtime's D1 adapter, which is
// tested against this same contract where it lives.
import type { SqlDatabase } from "@rendered-review/runtime";
import { Miniflare } from "miniflare";
import { sqlDatabaseContract } from "./contract";

sqlDatabaseContract("D1", async () => {
  const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
  const d1 = await mf.getD1Database("DB");
  const db: SqlDatabase = {
    all: async <Row>(sql: string, params: readonly unknown[] = []) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all()
      ).results as Row[],
    run: async (sql, params = []) => ({
      changes: (
        await d1
          .prepare(sql)
          .bind(...params)
          .run()
      ).meta.changes,
    }),
  };
  return { db, dialect: "sqlite", close: () => mf.dispose() };
});
