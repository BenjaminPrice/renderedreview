// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig, memoryLimiters, type RateLimiter, type RequestContext, type Scheduler } from "@rendered-review/runtime";
import { d1Database } from "./d1";

/**
 * Builds the request context from a Worker's `env`. Plain-text vars and secrets are strings;
 * other bindings (D1, etc.) are objects and are left out of config and the secret store.
 * The `DB` D1 binding becomes `db`; Wrangler applies its migrations at deploy time.
 * `GUEST_RATE_LIMIT` and `AUTH_RATE_LIMIT` Rate Limiting bindings, when present, replace the
 * in-memory guest and sign-in limits.
 */
export function buildRequestContext(env: object, waitUntil: Scheduler["waitUntil"]): RequestContext {
  const strings = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const config = loadConfig(strings, { databaseBinding: true });
  // Writes cost one per draft, which the binding cannot count, so they stay in memory (per isolate).
  const memory = memoryLimiters(config.limits);
  return {
    config,
    secrets: { get: async (name) => strings[name] },
    scheduler: { waitUntil },
    db: "DB" in env && env.DB ? d1Database(env.DB as D1Database) : undefined,
    // Set by Cloudflare's edge on every request; a client cannot forge it. TRUSTED_PROXY_HEADER is Node's.
    clientAddress: (request) => request.headers.get("cf-connecting-ip") ?? undefined,
    limiters: { ...memory, ...bound("guest", "GUEST_RATE_LIMIT"), ...bound("auth", "AUTH_RATE_LIMIT") },
  };

  function bound(name: string, binding: string): Record<string, RateLimiter> {
    const value = (env as Record<string, unknown>)[binding] as RateLimit | undefined;
    if (typeof value?.limit !== "function") return {};
    // The binding reports only success; its period (60 s in wrangler.jsonc) is the longest wait.
    return { [name]: { limit: async (key) => ((await value.limit({ key })).success ? 0 : 60) } };
  }
}
