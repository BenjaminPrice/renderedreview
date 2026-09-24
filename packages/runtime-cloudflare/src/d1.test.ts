// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { d1Database } from "./d1";

function mockD1(result: { results?: unknown[]; changes?: number }) {
  const bound = {
    all: vi.fn(async () => ({ results: result.results ?? [], success: true, meta: {} })),
    run: vi.fn(async () => ({ results: [], success: true, meta: { changes: result.changes ?? 0 } })),
  };
  const statement = { bind: vi.fn<(...params: unknown[]) => typeof bound>(() => bound) };
  const db = { prepare: vi.fn<(sql: string) => typeof statement>(() => statement) };
  return { db, d1: db as unknown as D1Database, statement };
}

describe("d1Database", () => {
  it("all() prepares, binds positional params and returns rows", async () => {
    const { db, d1, statement } = mockD1({ results: [{ id: 1, name: "a" }] });
    const rows = await d1Database(d1).all("SELECT * FROM t WHERE id = ? AND n = ?", [1, null]);
    expect(rows).toEqual([{ id: 1, name: "a" }]);
    expect(db.prepare).toHaveBeenCalledWith("SELECT * FROM t WHERE id = ? AND n = ?");
    expect(statement.bind).toHaveBeenCalledWith(1, null);
  });

  it("run() returns the changed row count", async () => {
    const { d1, statement } = mockD1({ changes: 3 });
    expect(await d1Database(d1).run("DELETE FROM t")).toEqual({ changes: 3 });
    expect(statement.bind).toHaveBeenCalledWith();
  });

  it("binds a Uint8Array as an ArrayBuffer holding only the view's bytes", async () => {
    const { d1, statement } = mockD1({});
    const view = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
    await d1Database(d1).run("INSERT INTO t (b) VALUES (?)", [view]);
    const blob = statement.bind.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(blob as ArrayBuffer)]).toEqual([1, 2]);
  });
});
