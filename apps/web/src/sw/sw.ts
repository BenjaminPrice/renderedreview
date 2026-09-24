// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="webworker" />
import { isStorable, isStorablePage, routeRequest } from "./policy";

declare const self: ServiceWorkerGlobalScope;
// Replaced at build time with the client build's file list and a hash of it (see vite.config.ts).
declare const __SW_MANIFEST__: { version: string; urls: string[] };

const { version, urls } = __SW_MANIFEST__;
const CACHE_PREFIX = "rendered-review-";
const CACHE = CACHE_PREFIX + version;

async function fetchAndStore(
  cache: Cache,
  request: Request | string,
  storable: (response: Response) => boolean,
): Promise<Response> {
  const response = await fetch(request);
  if (storable(response)) await cache.put(request, response.clone());
  else await cache.delete(request);
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(urls);
      // The first visit loads before the worker exists, so store the open pages that opt in.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(
        windows
          .filter(
            (w) =>
              routeRequest(
                { method: "GET", url: w.url, mode: "navigate", headers: new Headers() },
                self.location.origin,
              ) === "page",
          )
          .map((w) => fetchAndStore(cache, w.url, isStorablePage).catch(() => undefined)),
      );
      // ponytail: activates immediately; an open tab from the old deploy that lazy-loads a
      // chunk after this falls back to the network. Add an update prompt if that bites.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const route = routeRequest(request, self.location.origin);
  if (route === "asset") {
    // Hashed files are identical for every requester, so ignore `Vary: Origin`: module
    // scripts send an Origin header that the precache requests did not.
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) =>
            (await cache.match(request, { ignoreVary: true })) ?? fetchAndStore(cache, request, isStorable),
        ),
    );
  } else if (route === "page") {
    // Network first so SSR stays fresh; the cached copy is only the offline fallback.
    event.respondWith(
      caches
        .open(CACHE)
        .then((cache) =>
          fetchAndStore(cache, request, isStorablePage).catch(
            async () => (await cache.match(request)) ?? Response.error(),
          ),
        ),
    );
  }
});
