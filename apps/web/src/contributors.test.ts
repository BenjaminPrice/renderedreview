// SPDX-License-Identifier: AGPL-3.0-only
// Monthly active private contributors: the billing period, recording, and the admin read.
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type SqlDatabase } from "@rendered-review/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { billingAccountFor, type PrivateRepository } from "./billing";
import { activeContributors, billingPeriod, type ContributorTracker, contributorTrackerFor } from "./contributors";
import { testDatabases } from "./github/test-databases";
import { captureLogs } from "./test-utils";

describe("billingPeriod", () => {
  it("is the calendar month in UTC", () => {
    expect(billingPeriod(new Date("2026-09-25T12:00:00.000Z"))).toEqual({
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    });
  });

  it("rolls over at midnight UTC on the first, whatever the local time zone", () => {
    expect(billingPeriod(new Date("2026-09-30T23:59:59.999Z")).start).toBe("2026-09-01T00:00:00.000Z");
    expect(billingPeriod(new Date("2026-10-01T00:00:00.000Z")).start).toBe("2026-10-01T00:00:00.000Z");
    // Late on 31 December in New York is already January in UTC.
    expect(billingPeriod(new Date("2026-12-31T20:00:00-05:00"))).toEqual({
      start: "2027-01-01T00:00:00.000Z",
      end: "2027-02-01T00:00:00.000Z",
    });
  });
});

const env = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_CLIENT_ID: "Iv23.app-client",
  GITHUB_APP_CLIENT_SECRET: "app-client-secret",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_OAUTH_CLIENT_ID: "oauth-client",
  GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
  ENCRYPTION_KEY: btoa("k".repeat(32)),
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-32-chars!",
  DATABASE_URL: "sqlite::memory:",
  BILLING_PROVIDER: "stripe",
  BILLING_API_KEY: "sk_test",
  BILLING_WEBHOOK_SECRET: "whsec",
};
const hosted = loadConfig({ ...env, HOSTING_MODE: "hosted" });
type Owner = { id: string; login: string; type: "User" | "Organization" };
const acme: Owner = { id: "100", login: "acme", type: "Organization" };
const repo = (owner: Owner = acme): PrivateRepository => ({
  host: "github.com",
  owner: owner.login,
  name: "widgets",
  ownerId: owner.id,
  ownerType: owner.type,
});
const sept = new Date("2026-09-25T12:00:00.000Z");

describe("contributor tracking outside the hosted service", () => {
  it.each(["community", "dedicated"])("is off in %s mode and never touches the database", (mode) => {
    const db = { all: vi.fn(), run: vi.fn() };
    const config = loadConfig({ ...env, HOSTING_MODE: mode, ACCESS_POLICY: "all-accessible" });
    expect(contributorTrackerFor(config, db)).toBeUndefined();
    expect(db.all).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("is off without a database", () => {
    expect(contributorTrackerFor(hosted, undefined)).toBeUndefined();
  });
});

describe("recording a contributor never fails the publish", () => {
  it("swallows database errors and logs them without identifiers", async () => {
    const logs = captureLogs();
    const db = { all: vi.fn(), run: vi.fn(() => Promise.reject(new TypeError("connection to acme lost"))) };
    await expect(contributorTrackerFor(hosted, db)!(repo(), "user-secret-id")).resolves.toBeUndefined();
    expect(logs.events()).toEqual([
      { level: "warn", event: "billing.contributor", category: "failed", error: "TypeError" },
    ]);
    expect(logs.raw()).not.toMatch(/acme|user-secret-id|100/);
  });
});

describe.each(testDatabases)("active contributors on %s", (_, open) => {
  let db: SqlDatabase;
  let close: () => Promise<void>;
  let track: ContributorTracker;

  beforeAll(async () => {
    ({ db, close } = await open());
    await migrate(db);
    track = contributorTrackerFor(hosted, db)!;
  });
  afterAll(() => close());
  beforeEach(async () => {
    await db.run("DELETE FROM billing_account");
    await db.run("DELETE FROM github_owner");
    await db.run(`DELETE FROM "user"`);
  });

  /** A signed-in user with their GitHub account (GitHub's numeric user id). */
  async function signIn(userId: string, login: string, githubId: string) {
    const at = sept.toISOString();
    await db.run(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, login, `${login}@example.com`, 1, at, at],
    );
    await db.run(
      `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
      [`${userId}-github`, githubId, "github", userId, at, at],
    );
  }

  it("counts a GitHub user once per billing account per period, by GitHub user id", async () => {
    const account = await billingAccountFor(db, "github.com", acme);
    await signIn("u1", "mona", "9001");
    await signIn("u2", "hubot", "9002");
    await track(repo(), "u1", sept);
    await track(repo(), "u1", new Date("2026-09-26T00:00:00.000Z"));
    await track(repo(), "u2", sept);
    expect(await activeContributors(db, account.id, sept)).toEqual({
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      count: 2,
      contributors: [
        { githubUserId: "9002", login: "hubot", firstActiveAt: sept.toISOString() },
        { githubUserId: "9001", login: "mona", firstActiveAt: sept.toISOString() },
      ],
    });
  });

  it("stays idempotent when the same user publishes concurrently", async () => {
    const account = await billingAccountFor(db, "github.com", acme);
    await signIn("u1", "mona", "9001");
    await Promise.all(Array.from({ length: 10 }, () => track(repo(), "u1", sept)));
    expect((await activeContributors(db, account.id, sept)).count).toBe(1);
  });

  it("starts a fresh count when the period rolls over", async () => {
    const account = await billingAccountFor(db, "github.com", acme);
    await signIn("u1", "mona", "9001");
    await signIn("u2", "hubot", "9002");
    await track(repo(), "u1", new Date("2026-09-30T23:59:59.999Z"));
    await track(repo(), "u1", new Date("2026-10-01T00:00:00.000Z"));
    await track(repo(), "u2", new Date("2026-10-02T00:00:00.000Z"));
    expect((await activeContributors(db, account.id, sept)).count).toBe(1);
    const october = await activeContributors(db, account.id, new Date("2026-10-15T00:00:00.000Z"));
    expect(october.contributors.map((c) => c.login)).toEqual(["hubot", "mona"]);
    expect(october.contributors[1]!.firstActiveAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("counts against the repository owner's billing account, found by stable owner id", async () => {
    const acmeAccount = await billingAccountFor(db, "github.com", acme);
    const octoAccount = await billingAccountFor(db, "github.com", { id: "200", login: "octo", type: "User" });
    await signIn("u1", "mona", "9001");
    // The owner was renamed since: the stable id still finds its account.
    await track(repo({ ...acme, login: "acme-corp" }), "u1", sept);
    expect((await activeContributors(db, acmeAccount.id, sept)).count).toBe(1);
    expect((await activeContributors(db, octoAccount.id, sept)).count).toBe(0);
  });

  it("keeps the count when the user later deletes their Rendered Review account", async () => {
    const account = await billingAccountFor(db, "github.com", acme);
    await signIn("u1", "mona", "9001");
    await track(repo(), "u1", sept);
    await db.run(`DELETE FROM "user" WHERE "id" = ?`, ["u1"]);
    expect((await activeContributors(db, account.id, sept)).contributors).toEqual([
      { githubUserId: "9001", login: null, firstActiveAt: sept.toISOString() },
    ]);
  });

  it("records nothing for an owner without a billing account or a user without a GitHub account", async () => {
    const account = await billingAccountFor(db, "github.com", acme);
    await signIn("u1", "mona", "9001");
    await track(repo({ id: "999", login: "nobody", type: "User" }), "u1", sept);
    await track(repo(), "no-such-user", sept);
    expect(await db.all("SELECT * FROM active_contributor")).toEqual([]);
    expect((await activeContributors(db, account.id, sept)).count).toBe(0);
  });
});
