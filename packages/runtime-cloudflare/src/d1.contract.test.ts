// SPDX-License-Identifier: AGPL-3.0-only
// Runs the control-plane contract through the D1 adapter on a real local D1
// (workerd's D1 implementation, via Miniflare).
import { sqlDatabaseContract } from "@rendered-review/control-plane/contract";
import { Miniflare } from "miniflare";
import { d1Database } from "./d1";

sqlDatabaseContract("D1", async () => {
  const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
  const db = d1Database((await mf.getD1Database("DB")) as unknown as D1Database);
  return { db, dialect: "sqlite", close: () => mf.dispose() };
});
