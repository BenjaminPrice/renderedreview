// SPDX-License-Identifier: AGPL-3.0-only
// Server only: abuse limits. Guests and sign-in steps are counted per client address, writes per
// user, trial starts per user and per address per day. Addresses are only ever used as an HMAC
// under a server subkey, so no counter or log holds one. Exceeding a limit answers a typed 429
// (`{ code: "rate-limited", message, retryAfter }` plus `Retry-After`) and logs `rate.limited`
// with the limit's name only.
import { type AppConfig, log, type RateLimiter, type RequestContext } from "@rendered-review/runtime";

export type LimitName = "guest" | "auth" | "writes" | "trial-start";
/** The 429's message; the browser matches on it (the wait is in `retryAfter`). */
export const RATE_LIMITED = "Too many requests. Try again shortly.";

export class RateLimited extends Error {
  constructor(
    readonly limit: LimitName,
    /** Seconds until the client may try again. */
    readonly retryAfter: number,
  ) {
    super(RATE_LIMITED);
    this.name = "RateLimited";
  }
  get body() {
    return { code: "rate-limited" as const, message: this.message, retryAfter: this.retryAfter };
  }
}

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** HMAC-SHA256 of `message`, hex, under a subkey HKDF derives from `secret` for `info`. */
export async function hmacHex(secret: string | Uint8Array<ArrayBuffer>, info: string, message: string) {
  const cacheKey = typeof secret === "string" ? `${info}\n${secret}` : undefined;
  let key = cacheKey ? keys.get(cacheKey) : undefined;
  if (!key) {
    key = crypto.subtle
      .importKey("raw", typeof secret === "string" ? encoder.encode(secret) : secret, "HKDF", false, ["deriveKey"])
      .then((ikm) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(info) },
          ikm,
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign"],
        ),
      );
    if (cacheKey) {
      if (keys.size >= 16) keys.clear();
      keys.set(cacheKey, key);
    }
  }
  const mac = await crypto.subtle.sign("HMAC", await key, encoder.encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Without BETTER_AUTH_SECRET (public-only deployments) keys are only stable within this process
// or isolate, which is all the in-memory limiters need; on Workers the bindings then count per isolate.
const processSecret = crypto.getRandomValues(new Uint8Array(32));

/** The rate limit key for a client address. Requests without a known address share one bucket. */
export const addressKey = (config: AppConfig, address: string | undefined) =>
  hmacHex(config.authSecret ?? processSecret, "rendered-review rate limit v1", address ?? "unknown");

/** Counts one request (or `cost`) against `key`; the refusal when over the limit, logged by name. */
export async function checkLimit(
  limiter: RateLimiter,
  name: LimitName,
  key: string,
  cost = 1,
): Promise<RateLimited | undefined> {
  const retryAfter = await limiter.limit(key, cost);
  return retryAfter > 0 ? limited(name, retryAfter) : undefined;
}

/** Counts `request` against its client address's `name` limit. */
export async function limitClient(context: RequestContext, name: "guest" | "auth", request: Request) {
  return checkLimit(context.limiters[name], name, await addressKey(context.config, context.clientAddress(request)));
}

/** A refusal for `name`, logged. */
export function limited(name: LimitName, retryAfter: number) {
  log.info("rate.limited", { category: name });
  return new RateLimited(name, retryAfter);
}

/** The 429 for a refusal; `headers` are added (e.g. `Vary`). */
export function rateLimitedResponse(hit: RateLimited, headers: Record<string, string> = {}) {
  return Response.json(hit.body, {
    status: 429,
    headers: { "cache-control": "no-store", ...headers, "retry-after": String(hit.retryAfter) },
  });
}
