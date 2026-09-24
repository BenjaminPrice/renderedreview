// SPDX-License-Identifier: AGPL-3.0-only
// Shared server entry for every build. `#runtime` resolves to the platform's adapters
// (see "imports" in package.json), so this file stays free of platform APIs.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createRequestContext } from "#runtime";
import type { RequestContext } from "@rendered-review/runtime";
import { contentSecurityPolicy, createNonce } from "./csp";

declare module "@tanstack/react-start" {
  interface Register {
    // `nonce` is read by getRouter (router.tsx) so Start stamps it on the scripts it renders.
    server: { requestContext: RequestContext & { nonce: string } };
  }
}

// Vite dev injects un-nonced scripts and a websocket, so dev only reports violations.
const CSP_HEADER = import.meta.env.DEV ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

export default createServerEntry({
  fetch: async (request) => {
    const context = createRequestContext();
    const nonce = createNonce();
    const response = await handler.fetch(request, { context: { ...context, nonce } });
    // Copy, since some responses (e.g. Response.json, redirects) have immutable headers.
    const secured = new Response(response.body, response);
    secured.headers.set(CSP_HEADER, contentSecurityPolicy(context.config, nonce));
    // Following a link out (to GitHub, an external image) must not reveal the page being read.
    secured.headers.set("Referrer-Policy", "no-referrer");
    return secured;
  },
});
