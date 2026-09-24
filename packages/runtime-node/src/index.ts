// SPDX-License-Identifier: AGPL-3.0-only
// Node implementations of the runtime adapters. The app's server entry imports this through
// its `#runtime` import map, so it only ever lands in the Node build.
import { migrate } from "@rendered-review/control-plane";
import { errorName, log, type RequestContext, type SqlDatabase } from "@rendered-review/runtime";
import { loadNodeConfig } from "./config";
import { openDatabase } from "./database";

export { openDatabase, type NodeDatabase } from "./database";

let context: RequestContext | undefined;

export function createRequestContext(): RequestContext {
  // Config was already validated and logged at startup (./startup), so this cannot throw in practice.
  if (!context) {
    const config = loadNodeConfig();
    context = {
      config,
      secrets: { get: async (name) => process.env[name] },
      scheduler: {
        // Node keeps running after the response, so only make sure failures are logged.
        waitUntil: (work) =>
          void work.catch((error: unknown) => log.error("background.failed", { error: errorName(error) })),
      },
      db: config.databaseUrl ? migrated(openDatabase(config.databaseUrl)) : undefined,
    };
  }
  return context;
}

/** Applies pending migrations on first use; every query waits for them. */
function migrated(db: SqlDatabase): SqlDatabase {
  // ponytail: instances sharing one PostgreSQL race on first boot; run one instance first
  // (or add an advisory lock) when deploying several.
  const ready = migrate(db);
  ready.catch((error: unknown) => log.error("db.migration_failed", { error: errorName(error) }));
  return {
    all: async (sql, params) => (await ready, db.all(sql, params)),
    run: async (sql, params) => (await ready, db.run(sql, params)),
  };
}
