// SPDX-License-Identifier: AGPL-3.0-only
// Better Auth reads NODE_ENV once, when it loads, so this file sets it before anything is imported:
// these tests run the identity service as a production deployment would.
import { vi } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "production";
});

import { migrate } from "@rendered-review/control-plane";
import { loadConfig } from "@rendered-review/runtime";
import { openDatabase } from "@rendered-review/runtime-node";
import { afterAll, expect, it } from "vitest";
import { createIdentity } from "./identity";

afterAll(() => {
  process.env.NODE_ENV = "test";
});

const BASE = "https://rr.example";
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

const start = (identity: Awaited<ReturnType<typeof createIdentity>>) =>
  identity.handle(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    }),
  );

// The app limits sign-in per trusted client address in front of this (apps/web/src/auth.ts).
// Better Auth's own limiter would switch on here, key on a client-settable X-Forwarded-For and fall
// back to one shared bucket, so it is configured off.
it("leaves Better Auth's own rate limiter off in production", async () => {
  const db = openDatabase("sqlite::memory:");
  await migrate(db);
  const identity = await createIdentity({ config, db, baseURL: BASE });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await start(identity)).status);
  expect(statuses).toEqual([200, 200, 200, 200, 200]);
});
