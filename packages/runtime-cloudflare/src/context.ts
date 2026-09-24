// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig, type RequestContext, type Scheduler } from "@rendered-review/runtime";

/**
 * Builds the request context from a Worker's `env`. Plain-text vars and secrets are strings;
 * other bindings (D1, etc.) are objects and are left out of config and the secret store.
 */
export function buildRequestContext(env: object, waitUntil: Scheduler["waitUntil"]): RequestContext {
  const strings = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    config: loadConfig(strings, { databaseBinding: true }),
    secrets: { get: async (name) => strings[name] },
    scheduler: { waitUntil },
  };
}
