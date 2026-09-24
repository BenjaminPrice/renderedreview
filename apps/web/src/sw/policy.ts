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

// Server-rendered pages may one day carry private data. The server marks those
// `Cache-Control: private` or `no-store`, and the worker honours that.
export function isStorable(response: Pick<Response, "status" | "type" | "redirected" | "headers">): boolean {
  if (response.status !== 200 || response.type !== "basic" || response.redirected) return false;
  return !/\b(no-store|private)\b/i.test(response.headers.get("cache-control") ?? "");
}
