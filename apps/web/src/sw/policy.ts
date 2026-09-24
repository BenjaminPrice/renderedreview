// SPDX-License-Identifier: AGPL-3.0-only

// Which requests the service worker touches. Anything not "asset" or "page" is left
// entirely to the network: cross-origin (GitHub), non-GET, credentialed and API traffic.
export type Route = "asset" | "page" | "bypass";

export type RequestInfo = Pick<Request, "method" | "url" | "mode" | "headers">;

export function routeRequest(request: RequestInfo, origin: string): Route {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin) return "bypass";
  if (request.headers.has("authorization")) return "bypass";
  if (url.pathname.startsWith("/api/")) return "bypass";
  if (request.mode === "navigate") return "page";
  // Vite emits content-hashed, immutable files here.
  if (url.pathname.startsWith("/assets/")) return "asset";
  return "bypass";
}

// A response header the server sets on pages that are safe to keep for offline use.
export const OFFLINE_HEADER = "X-Rendered-Review-Offline";
export const OFFLINE_SHELL = "shell";

type StorableResponse = Pick<Response, "status" | "type" | "redirected" | "headers">;

// Build assets and opted-in pages: a plain 200 that HTTP caching rules allow storing.
export function isStorable(response: StorableResponse): boolean {
  if (response.status !== 200 || response.type !== "basic" || response.redirected) return false;
  return !/\b(no-store|private)\b/i.test(response.headers.get("cache-control") ?? "");
}

// Pages can carry private repository data, so they are stored only when the server
// explicitly opts in. The private/no-store check in isStorable still applies on top.
export function isStorablePage(response: StorableResponse): boolean {
  return response.headers.get(OFFLINE_HEADER) === OFFLINE_SHELL && isStorable(response);
}
