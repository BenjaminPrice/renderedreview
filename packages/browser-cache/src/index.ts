// SPDX-License-Identifier: AGPL-3.0-only
// Browser cache for GitHub responses, immutable Git objects and derived artifacts.
// Backed by IndexedDB; falls back to memory when IndexedDB is missing (SSR) or refuses to open
// (some private-browsing modes). Nothing touches `indexedDB` until the first read or write.
import type { CacheEntry, ResponseCache } from "@rendered-review/github-integration";

/** Private repository content is persisted only when the user opts in. */
export const PERSIST_PRIVATE_DEFAULT = false;

/** Policy text to show beside the private-repository caching opt-in. */
export const PRIVATE_CACHE_POLICY =
  "Content from private repositories is kept in memory for this tab only and is discarded when the tab closes. " +
  "If you turn on local caching for private repositories, that content is stored in this browser's IndexedDB " +
  "until you clear local data or the browser evicts it. Anyone with access to this browser profile can read it.";

/** Cached GitHub responses older than this are ignored, forcing a full fetch. Fresher ones are still revalidated by ETag. */
export const RESPONSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Cache Storage names with this prefix belong to the service worker and are removed by `clearLocalData`. */
export const CACHE_STORAGE_PREFIX = "rendered-review-";

/**
 * - `responses`: ETag-revalidated GitHub API responses (PR metadata, comments, file lists).
 * - `objects`: immutable blobs and trees, keyed with {@link objectKey}. Never expire.
 * - `derived`: values computed from immutable objects (parse trees, source maps, re-anchoring); include the blob OID in the key.
 * - `prefs`: UI preferences.
 * - `recent`: recently opened PRs.
 * - `drafts`: unpublished review comments, one list per pull request.
 */
export const STORES = ["responses", "objects", "derived", "prefs", "recent", "drafts"] as const;
export type StoreName = (typeof STORES)[number];

/** Stable key for immutable Git content. Never build keys from branch names. */
export const objectKey = (host: string, repositoryId: number, oid: string) => `${host}/${repositoryId}/${oid}`;

export interface SetOptions {
  /** True for anything read from a private repository, or when visibility is unknown. */
  private: boolean;
}

export interface BrowserCacheOptions {
  /** User opt-in to persist private repository content. Default {@link PERSIST_PRIVATE_DEFAULT}. */
  persistPrivate?: boolean;
}

export interface BrowserCache {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  set(store: StoreName, key: string, value: unknown, options: SetOptions): Promise<void>;
  /** A `ResponseCache` for the GitHub client. Use one per visibility. */
  responseCache(options: SetOptions): ResponseCache;
  /** Empties every store, in memory and IndexedDB, and deletes the service worker's caches. */
  clearLocalData(): Promise<void>;
}

const DB_NAME = "rendered-review";
/** Bump when adding a store; upgrades create the missing ones. */
const DB_VERSION = 2;

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function openDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      };
      request.onsuccess = () => {
        // Let a newer tab upgrade the schema instead of blocking on this connection.
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export function openBrowserCache({ persistPrivate = PERSIST_PRIVATE_DEFAULT }: BrowserCacheOptions = {}): BrowserCache {
  // ponytail: unbounded; holds private content and fallback data for the tab's lifetime. Add LRU if memory shows up.
  const memory = new Map<string, unknown>();
  let db: Promise<IDBDatabase | undefined> | undefined;
  const database = () => (db ??= openDb());

  const cache: BrowserCache = {
    async get<T>(store: StoreName, key: string) {
      const held = memory.get(`${store} ${key}`);
      if (held !== undefined) return held as T;
      const d = await database();
      if (!d) return undefined;
      try {
        return (await done(d.transaction(store).objectStore(store).get(key))) as T | undefined;
      } catch {
        return undefined;
      }
    },

    async set(store, key, value, options) {
      const memoryKey = `${store} ${key}`;
      const d = options.private && !persistPrivate ? undefined : await database();
      if (d) {
        try {
          await done(d.transaction(store, "readwrite").objectStore(store).put(value, key));
          memory.delete(memoryKey);
          return;
        } catch {
          // Quota exceeded or similar: keep it for this tab instead.
        }
      }
      memory.set(memoryKey, value);
    },

    responseCache: (options) => ({
      async get(key) {
        const entry = await cache.get<CacheEntry & { savedAt: number }>("responses", key);
        return entry && Date.now() - entry.savedAt <= RESPONSE_MAX_AGE_MS ? entry : undefined;
      },
      set: (key, entry) => cache.set("responses", key, { ...entry, savedAt: Date.now() }, options),
    }),

    async clearLocalData() {
      memory.clear();
      const d = await database();
      if (d) {
        const tx = d.transaction(STORES, "readwrite");
        for (const store of STORES) tx.objectStore(store).clear();
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = tx.onabort = () => reject(tx.error);
        });
      }
      if (typeof caches !== "undefined") {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith(CACHE_STORAGE_PREFIX)).map((n) => caches.delete(n)));
      }
    },
  };
  return cache;
}
