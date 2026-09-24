// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlDatabase, SqlValue } from "@rendered-review/runtime";

// D1 binds BLOBs from an ArrayBuffer, not a view.
const bindable = (params: readonly SqlValue[]) =>
  params.map((p) => (p instanceof Uint8Array ? p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) : p));

/** `SqlDatabase` over a D1 binding. D1 uses `?` placeholders natively, so statements pass through. */
export function d1Database(db: D1Database): SqlDatabase {
  return {
    async all<Row>(sql: string, params: readonly SqlValue[] = []) {
      const { results } = await db
        .prepare(sql)
        .bind(...bindable(params))
        .all<Row>();
      return results;
    },
    async run(sql: string, params: readonly SqlValue[] = []) {
      const { meta } = await db
        .prepare(sql)
        .bind(...bindable(params))
        .run();
      return { changes: meta.changes };
    },
  };
}
