// SPDX-License-Identifier: AGPL-3.0-only
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type RequestContext } from "@rendered-review/runtime";
import { openDatabase } from "@rendered-review/runtime-node";
import { describe, expect, it } from "vitest";
import { atPublicOrigin, handleAuthRequest, identityFor } from "./auth";
import { captureLogs, serverContext } from "./test-utils";

const publicOnly = serverContext(loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" }));

async function signInContext(env: Record<string, string> = {}): Promise<RequestContext> {
  const db = openDatabase("sqlite::memory:");
  await migrate(db);
  const config = loadConfig({
    HOSTING_MODE: "community",
    ACCESS_POLICY: "installed",
    GITHUB_APP_ID: "1",
    GITHUB_APP_CLIENT_ID: "Iv23.app",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_PRIVATE_KEY: "pem",
    GITHUB_APP_WEBHOOK_SECRET: "hook",
    ENCRYPTION_KEY: btoa("k".repeat(32)),
    BETTER_AUTH_SECRET: "s".repeat(32),
    DATABASE_URL: "sqlite::memory:",
    ...env,
  });
  return serverContext(config, { db });
}

it("answers 404 for every auth route when sign-in is not configured", async () => {
  const response = await handleAuthRequest(new Request("http://localhost:3000/api/auth/viewer"), publicOnly);
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await identityFor(publicOnly, "http://localhost:3000")).toBeUndefined();
});

it("serves auth routes for this request's origin when the GitHub App is configured", async () => {
  const context = await signInContext();
  const response = await handleAuthRequest(new Request("http://localhost:3000/api/auth/viewer"), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toBeNull();
  expect(await identityFor(context, "http://localhost:3000")).toBe(await identityFor(context, "http://localhost:3000"));
  expect(await identityFor(context, "https://rr.example")).not.toBe(
    await identityFor(context, "http://localhost:3000"),
  );
});

it("limits sign-in starts and callbacks per client address, with a typed 429, but not the viewer", async () => {
  captureLogs();
  const context = await signInContext({ RATE_LIMIT_AUTH_PER_MINUTE: "2" });
  const start = (client: string) =>
    handleAuthRequest(
      new Request("http://localhost:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-test-client": client },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      }),
      context,
    );
  const callback = (client: string) =>
    handleAuthRequest(
      new Request("http://localhost:3000/api/auth/callback/github?code=c&state=s", {
        headers: { "x-test-client": client },
      }),
      context,
    );
  expect((await start("198.51.100.1")).status).toBe(200);
  expect((await callback("198.51.100.1")).status).not.toBe(429);
  const limited = await start("198.51.100.1");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  expect(await limited.json()).toMatchObject({ code: "rate-limited", retryAfter: expect.any(Number) });
  expect((await callback("198.51.100.1")).status).toBe(429);
  // Another address has its own budget; the viewer lookup on every page load is not counted.
  expect((await start("198.51.100.2")).status).toBe(200);
  for (let i = 0; i < 3; i++) {
    const viewer = new Request("http://localhost:3000/api/auth/viewer", {
      headers: { "x-test-client": "198.51.100.1" },
    });
    expect((await handleAuthRequest(viewer, context)).status).toBe(200);
  }

describe("atPublicOrigin", () => {
  it("treats a request as addressed to the pinned origin, whatever its Host, keeping everything else", async () => {
    const request = new Request("http://attacker.example:8080/api/github/write/x?y=1", {
      method: "POST",
      headers: { origin: "https://rr.example", "content-type": "application/json" },
      body: '{"a":1}',
    });
    const pinned = atPublicOrigin(request, "https://rr.example");
    expect(pinned.url).toBe("https://rr.example/api/github/write/x?y=1");
    expect(pinned.method).toBe("POST");
    expect(pinned.headers.get("origin")).toBe("https://rr.example");
    expect(await pinned.text()).toBe('{"a":1}');
  });

  it("leaves the request alone without a pinned origin, or when it already matches", () => {
    const request = new Request("http://localhost:3000/health");
    expect(atPublicOrigin(request, undefined)).toBe(request);
    expect(atPublicOrigin(request, "http://localhost:3000")).toBe(request);
  });
});
