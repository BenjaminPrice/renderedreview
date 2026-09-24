// SPDX-License-Identifier: AGPL-3.0-only
// Node implementations of the runtime adapters. The app's server entry imports this through
// its `#runtime` import map, so it only ever lands in the Node build.
import { loadConfig, type RequestContext } from "@rendered-review/runtime";

let context: RequestContext | undefined;

export function createRequestContext(): RequestContext {
  // Config was already validated and logged at startup (./startup), so this cannot throw in practice.
  context ??= {
    config: loadConfig(process.env),
    secrets: { get: async (name) => process.env[name] },
    scheduler: {
      // Node keeps running after the response, so only make sure failures are logged.
      waitUntil: (work) => void work.catch((error: unknown) => console.error("Background task failed", error)),
    },
  };
  return context;
}
