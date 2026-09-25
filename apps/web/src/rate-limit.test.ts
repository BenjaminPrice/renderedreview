// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig, memoryRateLimiter } from "@rendered-review/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addressKey, checkLimit, limitClient, rateLimitedResponse, RateLimited } from "./rate-limit";
import { captureLogs, serverContext } from "./test-utils";

afterEach(() => vi.restoreAllMocks());

const withSecret = (secret: string) =>
  loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled", BETTER_AUTH_SECRET: secret });
const publicOnly = loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" });
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

describe("addressKey", () => {
  const config = withSecret("s".repeat(32));

  it("is a keyed hash of the address: stable, distinct per address, never the address itself", async () => {
    const key = await addressKey(config, "203.0.113.7");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("203");
    expect(await addressKey(config, "203.0.113.7")).toBe(key);
    expect(await addressKey(config, "203.0.113.8")).not.toBe(key);
    // Keyed: without the server's secret, the address space cannot be hashed to find it.
    const plain = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("203.0.113.7")));
    expect(key).not.toBe(plain);
    expect(await addressKey(withSecret("t".repeat(32)), "203.0.113.7")).not.toBe(key);
  });

  it("uses a random per-process key when the deployment has no secret", async () => {
    const key = await addressKey(publicOnly, "203.0.113.7");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await addressKey(publicOnly, "203.0.113.7")).toBe(key);
    expect(key).not.toBe(await addressKey(config, "203.0.113.7"));
  });

  it("puts every request without a known address in one bucket", async () => {
    expect(await addressKey(config, undefined)).toBe(await addressKey(config, undefined));
  });
});

describe("checkLimit", () => {
  it("passes under the limit and logs rate.limited with the limit name only once over it", async () => {
    const logs = captureLogs();
    const limiter = memoryRateLimiter({ limit: 1, periodSeconds: 60 });
    const key = await addressKey(publicOnly, "203.0.113.7");
    expect(await checkLimit(limiter, "guest", key)).toBeUndefined();
    const hit = await checkLimit(limiter, "guest", key);
    expect(hit).toBeInstanceOf(RateLimited);
    expect(hit).toMatchObject({ limit: "guest", retryAfter: 60 });
    expect(logs.events()).toEqual([{ level: "info", event: "rate.limited", category: "guest" }]);
    expect(logs.raw()).not.toContain(key);
    expect(logs.raw()).not.toContain("203.0.113.7");
  });
});

describe("rateLimitedResponse", () => {
  it("is a typed, uncached 429 with Retry-After", async () => {
    const res = rateLimitedResponse(new RateLimited("auth", 42));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      code: "rate-limited",
      message: "Too many requests. Try again shortly.",
      retryAfter: 42,
    });
  });
});

describe("limitClient", () => {
  const context = serverContext(
    loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled", RATE_LIMIT_GUEST_PER_MINUTE: "2" }),
  );
  const from = (address: string, spoofed = "") =>
    new Request("https://app.example/api/github/public/x", {
      headers: { "x-test-client": address, "x-forwarded-for": spoofed || address },
    });

  it("counts per trusted client address: a spoofed X-Forwarded-For neither evades nor frames anyone", async () => {
    captureLogs();
    expect(await limitClient(context, "guest", from("198.51.100.1", "1.1.1.1"))).toBeUndefined();
    expect(await limitClient(context, "guest", from("198.51.100.1", "2.2.2.2"))).toBeUndefined();
    expect(await limitClient(context, "guest", from("198.51.100.1", "3.3.3.3"))).toMatchObject({ limit: "guest" });
    expect(await limitClient(context, "guest", from("198.51.100.2", "198.51.100.1"))).toBeUndefined();
  });
});
