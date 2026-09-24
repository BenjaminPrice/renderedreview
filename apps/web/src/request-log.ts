// SPDX-License-Identifier: AGPL-3.0-only
// Server errors, logged by route template and error class: request paths name hosts, owners,
// repositories and files, and error messages can quote them (or tokens), so neither is logged.
import { errorName, log } from "@rendered-review/runtime";

const PREFIXES = [
  "/api/github/public/",
  "/api/github/user/",
  "/api/github/write/",
  "/api/auth/",
  "/_serverFn/",
  "/assets/",
];
const EXACT = new Set(["/", "/health", "/frames/mermaid"]);
const PULL = /^\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+\/?$/;

/** The route template for `pathname`, never the concrete path. */
export function appRoute(pathname: string): string {
  if (EXACT.has(pathname)) return pathname;
  if (PULL.test(pathname)) return "/:host/:owner/:repo/pull/:number";
  const prefix = PREFIXES.find((p) => pathname.startsWith(p));
  return prefix ? `${prefix}*` : "other";
}

/** Runs `handle`, logging a `server.error` event for a 5xx response or a thrown error (rethrown). */
export async function withErrorLog(request: Request, handle: () => Response | Promise<Response>): Promise<Response> {
  const fields = { method: request.method, route: appRoute(new URL(request.url).pathname) };
  try {
    const response = await handle();
    if (response.status >= 500) log.error("server.error", { ...fields, status: response.status });
    return response;
  } catch (error) {
    log.error("server.error", { ...fields, error: errorName(error) });
    throw error;
  }
}
