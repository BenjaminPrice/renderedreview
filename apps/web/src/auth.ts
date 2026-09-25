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
    // On Node the Host header picks the origin, so a client could mint origins at will.
    // ponytail: bounded by clearing; pin a configured public URL if this ever churns.
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
  if (SIGN_IN_STEP.test(new URL(request.url).pathname)) {
    const hit = await limitClient(context, "auth", request);
    if (hit) return rateLimitedResponse(hit);
  }
  return (await identity).handle(request);
}
