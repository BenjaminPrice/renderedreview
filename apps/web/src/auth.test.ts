// SPDX-License-Identifier: AGPL-3.0-only
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type RequestContext } from "@rendered-review/runtime";
import { openDatabase } from "@rendered-review/runtime-node";
import { expect, it } from "vitest";
import { handleAuthRequest, identityFor } from "./auth";

const base = { secrets: { get: async () => undefined }, scheduler: { waitUntil: () => {} } };
const publicOnly: RequestContext = {
  ...base,
  config: loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" }),
};

async function signInContext(): Promise<RequestContext> {
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
  });
  return { ...base, config, db };
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
