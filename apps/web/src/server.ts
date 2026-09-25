// SPDX-License-Identifier: AGPL-3.0-only
// Shared server entry for every build. `#runtime` resolves to the platform's adapters
// (see "imports" in package.json), so this file stays free of platform APIs.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createRequestContext } from "#runtime";
import type { RequestContext } from "@rendered-review/runtime";
import { atPublicOrigin } from "./auth";
import { contentSecurityPolicy, createNonce, secureResponse } from "./csp";
import { withErrorLog } from "./request-log";

declare module "@tanstack/react-start" {
  interface Register {
    // `nonce` is read by getRouter (router.tsx) so Start stamps it on the scripts it renders.
    server: { requestContext: RequestContext & { nonce: string } };
  }
}

// Vite dev injects un-nonced scripts and a websocket, so dev only reports violations.
const CSP_HEADER = import.meta.env.DEV ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

export default createServerEntry({
  fetch: async (incoming) => {
    const context = createRequestContext();
    const request = atPublicOrigin(incoming, context.config.publicUrl);
    const nonce = createNonce();
    const response = await withErrorLog(request, () => handler.fetch(request, { context: { ...context, nonce } }));
    return secureResponse(response, CSP_HEADER, contentSecurityPolicy(context.config, nonce));
  },
});
