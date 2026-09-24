// SPDX-License-Identifier: AGPL-3.0-only
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESPONSE_MAX_AGE_MS, STORES, objectKey, openBrowserCache } from "./index";

const pub = { private: false };
const priv = { private: true };

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openBrowserCache", () => {
  it("persists public values across instances", async () => {
    const key = objectKey("github.com", 42, "abc123");
    await openBrowserCache().set("objects", key, "# Hello", pub);
    expect(await openBrowserCache().get("objects", key)).toBe("# Hello");
    expect(await openBrowserCache().get("objects", "github.com/42/other")).toBeUndefined();
  });

  it("round-trips ETag entries and ignores ones past the max age", async () => {
    const entry = { etag: 'W/"abc"', body: { title: "PR" }, next: "https://api.github.com/x?page=2" };
    await openBrowserCache().responseCache(pub).set("scope accept url", entry);

    const responses = openBrowserCache().responseCache(pub);
    expect(await responses.get("scope accept url")).toMatchObject(entry);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + RESPONSE_MAX_AGE_MS + 1);
    expect(await responses.get("scope accept url")).toBeUndefined();
  });

  it("keeps private values in memory only unless the user opts in", async () => {
    const tab = openBrowserCache();
    await tab.set("derived", "k", { ast: 1 }, priv);
    await tab.responseCache(priv).set("r", { etag: '"e"', body: "secret" });
    expect(await tab.get("derived", "k")).toEqual({ ast: 1 });
    expect(await tab.responseCache(priv).get("r")).toMatchObject({ body: "secret" });

    const reopened = openBrowserCache();
    expect(await reopened.get("derived", "k")).toBeUndefined();
    expect(await reopened.get("responses", "r")).toBeUndefined();

    await openBrowserCache({ persistPrivate: true }).set("derived", "k", { ast: 2 }, priv);
    expect(await openBrowserCache().get("derived", "k")).toEqual({ ast: 2 });
  });

  it("clearLocalData empties every store and the service worker caches", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("caches", {
      keys: async () => ["rendered-review-v1", "rendered-review-v2", "someone-else"],
      delete: async (name: string) => deleted.push(name),
    });
    const cache = openBrowserCache();
    for (const store of STORES) await cache.set(store, "k", store, pub);
    await cache.set("prefs", "private", 1, priv);

    await cache.clearLocalData();

    const reopened = openBrowserCache();
    for (const store of STORES) expect(await reopened.get(store, "k")).toBeUndefined();
    expect(await cache.get("prefs", "private")).toBeUndefined();
    expect(deleted).toEqual(["rendered-review-v1", "rendered-review-v2"]);
  });

  it.each([
    ["missing", () => vi.stubGlobal("indexedDB", undefined)],
    [
      "failing to open",
      () =>
        vi.stubGlobal("indexedDB", {
          open: () => {
            throw new DOMException("denied", "InvalidStateError");
          },
        }),
    ],
  ])("falls back to memory when IndexedDB is %s", async (_, breakIt) => {
    breakIt();
    const cache = openBrowserCache();
    await cache.set("recent", "list", ["github.com/1/2"], pub);
    await cache.responseCache(pub).set("r", { etag: '"e"', body: 1 });
    expect(await cache.get("recent", "list")).toEqual(["github.com/1/2"]);
    expect(await cache.responseCache(pub).get("r")).toMatchObject({ body: 1 });
    await cache.clearLocalData();
    expect(await cache.get("recent", "list")).toBeUndefined();
  });
});
