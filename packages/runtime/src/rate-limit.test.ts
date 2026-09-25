// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryRateLimiter } from "./rate-limit";

afterEach(() => vi.useRealTimers());

describe("memoryRateLimiter", () => {
  it("allows `limit` requests per key per period, then answers the seconds to wait", async () => {
    vi.useFakeTimers({ now: 0 });
    const limiter = memoryRateLimiter({ limit: 2, periodSeconds: 60 });
    expect(await limiter.limit("a")).toBe(0);
    expect(await limiter.limit("a")).toBe(0);
    expect(await limiter.limit("b")).toBe(0);
    vi.setSystemTime(15_500);
    expect(await limiter.limit("a")).toBe(45);
  });

  it("resets when the window ends", async () => {
    vi.useFakeTimers({ now: 0 });
    const limiter = memoryRateLimiter({ limit: 1, periodSeconds: 10 });
    await limiter.limit("a");
    expect(await limiter.limit("a")).toBeGreaterThan(0);
    vi.setSystemTime(10_000);
    expect(await limiter.limit("a")).toBe(0);
  });

  it("counts a cost greater than one", async () => {
    const limiter = memoryRateLimiter({ limit: 5, periodSeconds: 60 });
    expect(await limiter.limit("a", 5)).toBe(0);
    expect(await limiter.limit("a", 1)).toBeGreaterThan(0);
  });

  it("stays bounded: past the key cap it starts over rather than growing", async () => {
    const limiter = memoryRateLimiter({ limit: 1, periodSeconds: 60, maxKeys: 2 });
    await limiter.limit("a");
    await limiter.limit("b");
    await limiter.limit("c");
    // The map was cleared to make room, so "a" starts a fresh window.
    expect(await limiter.limit("a")).toBe(0);
  });
});
