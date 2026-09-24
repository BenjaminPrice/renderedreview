// SPDX-License-Identifier: AGPL-3.0-only
// Shared server entry for every build. `#runtime` resolves to the platform's adapters
// (see "imports" in package.json), so this file stays free of platform APIs.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createRequestContext } from "#runtime";
import type { RequestContext } from "@rendered-review/runtime";

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: RequestContext };
  }
}

export default createServerEntry({
  fetch: (request) => handler.fetch(request, { context: createRequestContext() }),
});
