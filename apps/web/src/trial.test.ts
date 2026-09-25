// SPDX-License-Identifier: AGPL-3.0-only
// The no-card private-repository trial, through the hosted entitlement check, on SQLite and PostgreSQL.
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type SqlDatabase } from "@rendered-review/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { entitlementCheckFor, type Requester } from "./billing";
import { testDatabases } from "./github/test-databases";
import { TRIAL_CONTRIBUTORS, trialSubjectKey } from "./trial";

const secret = "a-better-auth-secret-of-32-chars!";
const env = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_CLIENT_ID: "Iv23.app-client",
  GITHUB_APP_CLIENT_SECRET: "app-client-secret",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
  ENCRYPTION_KEY: btoa("k".repeat(32)),
  BETTER_AUTH_SECRET: secret,
  GITHUB_OAUTH_CLIENT_ID: "oauth-client",
  GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
  DATABASE_URL: "sqlite::memory:",
  BILLING_PROVIDER: "stripe",
  BILLING_API_KEY: "sk_test",
  BILLING_WEBHOOK_SECRET: "whsec",
};
const hosted = loadConfig({ ...env, HOSTING_MODE: "hosted" });

const acme = { host: "github.com", owner: "acme", name: "widgets", ownerId: "100", ownerType: "Organization" } as const;
const start = new Date("2026-09-25T12:00:00.000Z");
const days = (n: number) => new Date(start.getTime() + n * 86_400_000);
const reader = (userId = "u1"): Requester => ({ userId, operation: "read" });
const writer = (userId = "u1"): Requester => ({ userId, operation: "write" });

describe("trial ledger key", () => {
  it("is a keyed hash of host, subject type and stable owner ID, never the raw ID", async () => {
    const key = await trialSubjectKey(secret, "github.com", { id: "100", type: "Organization" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("100");
    expect(await trialSubjectKey(secret, "GitHub.com", { id: "100", type: "Organization" })).toBe(key);
    for (const other of [
      trialSubjectKey(secret, "ghe.example.com", { id: "100", type: "Organization" }),
      trialSubjectKey(secret, "github.com", { id: "100", type: "User" }),
      trialSubjectKey(secret, "github.com", { id: "101", type: "Organization" }),
      trialSubjectKey(`${secret}-other`, "github.com", { id: "100", type: "Organization" }),
    ])
      expect(await other).not.toBe(key);
  });
});

describe.each(testDatabases)("private-repository trial on %s", (_, open) => {
  let db: SqlDatabase;
  let close: () => Promise<void>;
  let installed: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  let check: NonNullable<ReturnType<typeof entitlementCheckFor>>;

  beforeAll(async () => {
    ({ db, close } = await open());
    await migrate(db);
  });
  afterAll(() => close());
  beforeEach(async () => {
    for (const table of ["trial", "billing_account", "github_owner", `"user"`]) await db.run(`DELETE FROM ${table}`);
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    installed = vi.fn(async () => true);
    check = entitlementCheckFor(hosted, db, installed)!;
  });
  afterEach(() => vi.useRealTimers());

  const ledger = () =>
    db.all<{
      started_at: string;
      expires_at: string;
      status: string;
      contributor_limit: number;
      account: string | null;
    }>(`SELECT started_at, expires_at, status, contributor_limit, billing_account_id AS account FROM trial`);
  const entitlements = () =>
    db.all(`SELECT plan_id, source, contributor_limit, valid_until FROM entitlement ORDER BY valid_until`);

  it("starts when a signed-in reader first opens a private document of an owner with no plan", async () => {
    const ends = days(30).toISOString();
    expect(await check(acme, reader())).toEqual({ allowed: true, reason: "trial", validUntil: ends });
    const [account] = await db.all<{ id: string }>("SELECT billing_account_id AS id FROM github_owner");
    expect(await ledger()).toEqual([
      {
        started_at: start.toISOString(),
        expires_at: ends,
        status: "active",
        contributor_limit: TRIAL_CONTRIBUTORS,
        account: account!.id,
      },
    ]);
    expect(await entitlements()).toEqual([
      { plan_id: "team", source: "trial", contributor_limit: TRIAL_CONTRIBUTORS, valid_until: ends },
    ]);
    // Later reads use the same trial.
    vi.setSystemTime(days(3));
    expect(await check(acme, reader("u2"))).toEqual({ allowed: true, reason: "trial", validUntil: ends });
    expect(await ledger()).toHaveLength(1);
  });

  it("does not start without a signed-in reader, the installation or when the owner has a plan", async () => {
    expect(await check(acme)).toEqual({ allowed: false, reason: "no-entitlement" });
    installed.mockResolvedValue(false);
    expect(await check(acme, reader())).toEqual({ allowed: false, reason: "not-installed" });
    expect(await ledger()).toEqual([]);

    installed.mockResolvedValue(true);
    const account = crypto.randomUUID();
    await db.run("INSERT INTO billing_account (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      account,
      "acme",
      start.toISOString(),
      start.toISOString(),
    ]);
    await db.run(
      `INSERT INTO github_owner (id, host, github_id, type, login, billing_account_id, created_at, updated_at)
       VALUES (?, 'github.com', '100', 'Organization', 'acme', ?, ?, ?)`,
      [crypto.randomUUID(), account, start.toISOString(), start.toISOString()],
    );
    await db.run(
      `INSERT INTO entitlement (billing_account_id, plan_id, source, contributor_limit, valid_until, updated_at)
       VALUES (?, 'team', 'subscription', 10, NULL, ?)`,
      [account, start.toISOString()],
    );
    expect(await check(acme, reader())).toEqual({ allowed: true, reason: "subscription" });
    expect(await ledger()).toEqual([]);
  });

  it("starts one trial when two first opens race", async () => {
    const results = await Promise.all([check(acme, reader("u1")), check(acme, reader("u2"))]);
    expect(results.map((r) => r.allowed)).toEqual([true, true]);
    expect(await ledger()).toHaveLength(1);
    expect(await entitlements()).toHaveLength(1);
  });

  it("ends after 30 days: private reads and publishing are refused as an ended trial", async () => {
    await check(acme, reader());
    vi.setSystemTime(days(30));
    expect(await check(acme, reader())).toEqual({ allowed: false, reason: "trial-expired" });
    expect(await check(acme, writer())).toEqual({ allowed: false, reason: "trial-expired" });
    expect((await ledger())[0]!.status).toBe("expired");
  });

  it("is not granted again by a reinstall", async () => {
    await check(acme, reader());
    installed.mockResolvedValue(false); // uninstalled
    expect(await check(acme, reader())).toEqual({ allowed: false, reason: "not-installed" });
    vi.setSystemTime(days(31));
    installed.mockResolvedValue(true); // installed again
    expect(await check(acme, reader())).toEqual({ allowed: false, reason: "trial-expired" });
    expect(await ledger()).toHaveLength(1);
  });

  it("is not reset by renaming the owner or opening another repository", async () => {
    await check(acme, reader());
    vi.setSystemTime(days(31));
    expect(await check({ ...acme, owner: "acme-corp", name: "gadgets" }, reader())).toEqual({
      allowed: false,
      reason: "trial-expired",
    });
    expect(await ledger()).toHaveLength(1);
  });

  it("is not reset when the billing account is deleted and created again", async () => {
    await check(acme, reader());
    await db.run("DELETE FROM billing_account");
    expect((await ledger())[0]!.account).toBeNull();

    // Within the 30 days, the new account continues the same trial.
    vi.setSystemTime(days(10));
    expect(await check(acme, reader())).toEqual({ allowed: true, reason: "trial", validUntil: days(30).toISOString() });
    const [account] = await db.all<{ id: string }>("SELECT billing_account_id AS id FROM github_owner");
    expect((await ledger())[0]!.account).toBe(account!.id);

    await db.run("DELETE FROM billing_account");
    vi.setSystemTime(days(40));
    expect(await check(acme, reader())).toEqual({ allowed: false, reason: "trial-expired" });
    expect(await entitlements()).toEqual([]);
  });

  describe("contributor cap", () => {
    const contributor = async (n: number) => {
      const userId = `u${n}`;
      const now = start.toISOString();
      await db.run(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
        [userId, userId, `${userId}@example.com`, now, now],
      );
      await db.run(
        `INSERT INTO account ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?, ?, 'github', ?, ?, ?)`,
        [`a${n}`, String(9000 + n), userId, now, now],
      );
      return userId;
    };
    // What publishing records for each contributor (the active-contributor tracking).
    const active = async (userIds: string[]) => {
      const [{ id }] = (await db.all<{ id: string }>("SELECT billing_account_id AS id FROM github_owner")) as [
        { id: string },
      ];
      for (const userId of userIds)
        await db.run(
          `INSERT INTO active_contributor (billing_account_id, period_start, github_user_id, first_active_at)
           SELECT ?, ?, "accountId", ? FROM account WHERE "userId" = ?`,
          [id, "2026-09-01T00:00:00.000Z", start.toISOString(), userId],
        );
    };

    it("refuses an eleventh new contributor's publish; the first ten keep publishing", async () => {
      const users = await Promise.all(Array.from({ length: 11 }, (_, i) => contributor(i + 1)));
      await check(acme, reader(users[0]));
      await active(users.slice(0, 10));
      expect(await check(acme, writer(users[10]))).toEqual({ allowed: false, reason: "trial-contributor-cap" });
      expect(await check(acme, writer(users[3]))).toEqual({
        allowed: true,
        reason: "trial",
        validUntil: days(30).toISOString(),
      });
      // Reading is never capped.
      expect((await check(acme, reader(users[10]))).allowed).toBe(true);
    });

    it("follows a larger, sales-approved limit set on the ledger and entitlement", async () => {
      const users = await Promise.all(Array.from({ length: 11 }, (_, i) => contributor(i + 1)));
      await check(acme, reader(users[0]));
      await active(users.slice(0, 10));
      await db.run("UPDATE trial SET contributor_limit = 25");
      await db.run("UPDATE entitlement SET contributor_limit = 25");
      expect((await check(acme, writer(users[10]))).allowed).toBe(true);
    });
  });

  it.each(["community", "dedicated"] as const)("never runs in %s mode", async (mode) => {
    const spy = { all: vi.fn(), run: vi.fn() };
    const config = loadConfig({ ...env, HOSTING_MODE: mode, ACCESS_POLICY: "installed" });
    const dedicated = entitlementCheckFor(config, spy, installed);
    if (mode === "community") return expect(dedicated).toBeUndefined();
    expect(await dedicated!(acme, reader())).toEqual({ allowed: true, reason: "access-policy" });
    expect(await dedicated!(acme, writer())).toEqual({ allowed: true, reason: "access-policy" });
    expect(spy.all).not.toHaveBeenCalled();
    expect(spy.run).not.toHaveBeenCalled();
  });
});
