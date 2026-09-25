// SPDX-License-Identifier: AGPL-3.0-only
// GitHub sign-in for this deployment. Off (every auth route 404s, the UI hides sign-in) unless the
// GitHub App, its secrets and a database are configured, so public-only mode is unchanged.
import { authEnabled, createIdentity, type Identity } from "@rendered-review/identity";
import type { RequestContext } from "@rendered-review/runtime";
import { limitClient, rateLimitedResponse } from "./rate-limit";

// One instance per public origin: OAuth redirect URIs and cookie security follow the origin the
// browser used. The context (config, db) is per process/isolate, so this cache is too.
const identities = new WeakMap<RequestContext["config"], Map<string, Promise<Identity>>>();

/** The deployment's identity service for `origin`, or undefined when sign-in is not configured. */
export function identityFor(context: RequestContext, origin: string): Promise<Identity> | undefined {
  if (!context.db || !authEnabled(context.config, true)) return undefined;
  let byOrigin = identities.get(context.config);
  if (!byOrigin) identities.set(context.config, (byOrigin = new Map()));
  let identity = byOrigin.get(origin);
  if (!identity) {
    // Without PUBLIC_URL, on Node the Host header picks the origin, so a client could mint origins
    // at will; bounded by clearing. With it, the server entry pins every request to one origin.
    if (byOrigin.size >= 16) byOrigin.clear();
    identity = createIdentity({ config: context.config, db: context.db, baseURL: origin });
    byOrigin.set(origin, identity);
  }
  return identity;
}

// Starting sign-in or linking writes a verification row and each callback calls GitHub: counted
// per client address. The viewer lookup and sign-out are not.
const SIGN_IN_STEP = /^\/api\/auth\/(?:sign-in\/social|link-social|callback\/[\w-]+)$/;

export async function handleAuthRequest(request: Request, context: RequestContext): Promise<Response> {
  const identity = identityFor(context, new URL(request.url).origin);
  if (!identity) return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  const { pathname } = new URL(request.url);
  if (SIGN_IN_STEP.test(pathname)) {
    const hit = await limitClient(context, "auth", request);
    // A callback is a browser navigation back from GitHub: land on a page that explains.
    if (hit && pathname.startsWith("/api/auth/callback/"))
      return new Response(null, {
        status: 302,
        headers: { location: `/?error=too_many_requests&retry_after=${hit.retryAfter}`, "cache-control": "no-store" },
      });
    if (hit) return rateLimitedResponse(hit);
  }
  return (await identity).handle(request);
}

/**
 * `request` as addressed to the configured public origin (`PUBLIC_URL`), whatever its Host header,
 * so OAuth callbacks, redirects and same-origin checks follow the configured origin. Unchanged when
 * none is configured (Workers: the platform's request URL is already the public one).
 */
export function atPublicOrigin(request: Request, publicUrl: string | undefined): Request {
  const url = new URL(request.url);
  if (!publicUrl || url.origin === publicUrl) return request;
  return new Request(publicUrl + url.pathname + url.search, request);
}
