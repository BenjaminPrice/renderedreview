// SPDX-License-Identifier: AGPL-3.0-only
// Request rate limits. Each runtime supplies its limiters (Workers: the Rate Limiting binding where
// one is configured; otherwise this in-memory window). Keys are opaque: callers pass a user ID or an
// HMAC of a client address, never a raw address. Web Platform APIs only.
import type { Limiters } from "./adapters";
import type { AppConfig } from "./config";

export interface RateLimiter {
  /** Counts `cost` (default 1) against `key`: 0 when allowed, else the seconds until it may retry. */
  limit(key: string, cost?: number): Promise<number>;
}

/**
 * A fixed window per key, held in memory.
 * ponytail: per process/isolate, so several instances multiply the limit; a shared store (KV,
 * database, Redis) when running more than one. Cleared when full rather than evicting, which can
 * forgive one window's counts under a flood of distinct keys.
 */
export function memoryRateLimiter({
  limit,
  periodSeconds,
  maxKeys = 10_000,
}: {
  limit: number;
  periodSeconds: number;
  maxKeys?: number;
}): RateLimiter {
  const windows = new Map<string, { count: number; until: number }>();
  return {
    async limit(key, cost = 1) {
      const now = Date.now();
      let window = windows.get(key);
      if (!window || window.until <= now) {
        if (windows.size >= maxKeys) windows.clear();
        windows.set(key, (window = { count: 0, until: now + periodSeconds * 1000 }));
      }
      window.count += cost;
      return window.count > limit ? Math.max(1, Math.ceil((window.until - now) / 1000)) : 0;
    },
  };
}

/** Every limiter in memory, sized from config. */
export const memoryLimiters = (limits: AppConfig["limits"]): Limiters => ({
  guest: memoryRateLimiter({ limit: limits.guestPerMinute, periodSeconds: 60 }),
  auth: memoryRateLimiter({ limit: limits.authPerMinute, periodSeconds: 60 }),
  writes: memoryRateLimiter({ limit: limits.writesPerMinute, periodSeconds: 60 }),
});
