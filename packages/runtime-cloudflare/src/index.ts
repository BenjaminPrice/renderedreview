// SPDX-License-Identifier: AGPL-3.0-only
// Cloudflare Workers implementations of the runtime adapters. The app's server entry imports this
// through its `#runtime` import map ("workerd" condition), so it only lands in the Workers build.
import { env, waitUntil } from "cloudflare:workers";
import type { RequestContext } from "@rendered-review/runtime";
import { buildRequestContext } from "./context";

export { d1Database } from "./d1";

let context: RequestContext | undefined;

/** Per-isolate context from the Worker's bindings. `waitUntil` extends the current request's lifetime. */
export function createRequestContext(): RequestContext {
  // Workers have no boot hook, so an invalid config throws a readable ConfigError on the first request.
  context ??= buildRequestContext(env, waitUntil);
  return context;
}
