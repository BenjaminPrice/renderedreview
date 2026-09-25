// SPDX-License-Identifier: AGPL-3.0-only
import { ConfigError } from "@rendered-review/runtime";
import { describe, expect, it, vi } from "vitest";
import { buildRequestContext } from "./context";

const d1Binding = { prepare: () => undefined };
const publicOnly = { HOSTING_MODE: "community", ACCESS_POLICY: "disabled" };

describe("buildRequestContext", () => {
  it("builds config and secrets from string bindings, ignoring other bindings", async () => {
    const env = { ...publicOnly, SOME_SECRET: "secret-value", DB: d1Binding };
    const context = buildRequestContext(env, () => {});
    expect(context.config).toMatchObject({ hostingMode: "community", accessPolicy: "disabled" });
    expect(await context.secrets.get("SOME_SECRET")).toBe("secret-value");
    expect(await context.secrets.get("DB")).toBeUndefined();
    expect(await context.secrets.get("MISSING")).toBeUndefined();
    expect(context.db).toBeDefined();
    expect(buildRequestContext(publicOnly, () => {}).db).toBeUndefined();
  });

  it("does not require DATABASE_URL because D1 is bound", () => {
    const env = {
      HOSTING_MODE: "community",
      ACCESS_POLICY: "installed",
      GITHUB_APP_ID: "1",
      GITHUB_APP_CLIENT_ID: "Iv1.app",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: "pem",
      GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
      ENCRYPTION_KEY: btoa("k".repeat(32)),
      BETTER_AUTH_SECRET: "s".repeat(32),
      DB: d1Binding,
    };
    expect(buildRequestContext(env, () => {}).config.databaseUrl).toBeUndefined();
  });

  it("hands background work to the execution context's waitUntil", () => {
    const waitUntil = vi.fn();
    const work = Promise.resolve();
    buildRequestContext(publicOnly, waitUntil).scheduler.waitUntil(work);
    expect(waitUntil).toHaveBeenCalledWith(work);
  });

  it("throws a readable ConfigError for invalid vars", () => {
    expect(() => buildRequestContext({}, () => {})).toThrow(ConfigError);
  });

  it("takes the client address from CF-Connecting-IP only, never a client-sent X-Forwarded-For", () => {
    const { clientAddress } = buildRequestContext({ ...publicOnly, TRUSTED_PROXY_HEADER: "x-forwarded-for" }, () => {});
    const headers = { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6" };
    expect(clientAddress(new Request("https://rr.example/", { headers }))).toBe("203.0.113.7");
    expect(clientAddress(new Request("https://rr.example/", { headers: { "x-forwarded-for": "6.6.6.6" } }))).toBe(
      undefined,
    );
  });

  it("limits guests and sign-ins with the Rate Limiting bindings when configured", async () => {
    const guest = { limit: vi.fn(async () => ({ success: false })) };
    const auth = { limit: vi.fn(async () => ({ success: true })) };
    const { limiters } = buildRequestContext({ ...publicOnly, GUEST_RATE_LIMIT: guest, AUTH_RATE_LIMIT: auth }, () => {});
    expect(await limiters.guest.limit("k1")).toBe(60);
    expect(guest.limit).toHaveBeenCalledWith({ key: "k1" });
    expect(await limiters.auth.limit("k2")).toBe(0);
    expect(auth.limit).toHaveBeenCalledWith({ key: "k2" });
  });

  it("falls back to in-memory limits from config without bindings; writes always count in memory", async () => {
    const { limiters } = buildRequestContext({ ...publicOnly, RATE_LIMIT_GUEST_PER_MINUTE: "1" }, () => {});
    expect(await limiters.guest.limit("k")).toBe(0);
    expect(await limiters.guest.limit("k")).toBeGreaterThan(0);
    expect(await limiters.writes.limit("u", 60)).toBe(0);
    expect(await limiters.writes.limit("u")).toBeGreaterThan(0);
  });
});
