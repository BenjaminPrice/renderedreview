// SPDX-License-Identifier: AGPL-3.0-only
// The no-card private-repository trial, through the hosted entitlement check, on SQLite and PostgreSQL.
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type SqlDatabase } from "@rendered-review/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { entitlementCheckFor, type Requester } from "./billing";
import { contributorTrackerFor } from "./contributors";
import { testDatabases } from "./github/test-databases";
import { RateLimited } from "./rate-limit";
import { captureLogs } from "./test-utils";
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
    for (const table of ["trial", "billing_account", "github_owner", `"user"`, "usage_counter"])
      await db.run(`DELETE FROM ${table}`);
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

  describe("trial start limits", () => {
    const owner = (n: number) => ({ ...acme, owner: `org${n}`, ownerId: String(1000 + n) });
    const from = (userId: string, clientAddress: string): Requester => ({ userId, operation: "read", clientAddress });

    it("lets one user start at most TRIAL_STARTS_PER_DAY trials a day, then answers when to retry", async () => {
      const logs = captureLogs();
      for (let n = 1; n <= 3; n++) expect((await check(owner(n), from("u1", `198.51.100.${n}`))).allowed).toBe(true);
      const refused = await check(owner(4), from("u1", "198.51.100.4")).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RateLimited);
      // Retry at the next UTC midnight: the test clock is 12:00.
      expect(refused).toMatchObject({ limit: "trial-start-user", retryAfter: 12 * 3600 });
      expect((refused as Error).message).not.toMatch(/network/);
      expect(await ledger()).toHaveLength(3);
      expect(logs.events()).toContainEqual({ level: "info", event: "rate.limited", category: "trial-start-user" });
      // Trials already running are unaffected, and the next day the user may start again.
      expect((await check(owner(1), from("u1", "198.51.100.1"))).allowed).toBe(true);
      vi.setSystemTime(days(1));
      expect((await check(owner(4), from("u1", "198.51.100.4"))).allowed).toBe(true);
    });

    const userCount = async (userId = "u1") =>
      Number(
        (
          await db.all<{ count: number }>(
            "SELECT count FROM usage_counter WHERE scope = 'user' AND subject = ? AND metric = 'trial-start'",
            [userId],
          )
        )[0]?.count ?? 0,
      );

    it("counts only trials actually started: not refusals, not reopening a running trial", async () => {
      captureLogs();
      for (let n = 1; n <= 3; n++) await check(owner(n), from("u1", "198.51.100.1"));
      await expect(check(owner(4), from("u1", "198.51.100.1"))).rejects.toBeInstanceOf(RateLimited);
      expect(await userCount()).toBe(3);
      // At the limit, the user's running trials still open, and opening them counts nothing.
      for (let n = 1; n <= 3; n++) expect((await check(owner(n), from("u1", "198.51.100.1"))).allowed).toBe(true);
      expect(await userCount()).toBe(3);
    });

    it("restores an earlier trial at the limit without counting it (recreated billing account)", async () => {
      captureLogs();
      for (let n = 1; n <= 3; n++) await check(owner(n), from("u1", "198.51.100.1"));
      // The owner's entitlement goes with its billing account; the ledger keeps the trial.
      await db.run("DELETE FROM billing_account");
      expect((await check(owner(1), from("u1", "198.51.100.1"))).allowed).toBe(true);
      expect(await userCount()).toBe(3);
    });

    it("counts one start when two first opens race", async () => {
      await Promise.all([check(owner(1), from("u1", "198.51.100.1")), check(owner(1), from("u1", "198.51.100.1"))]);
      expect(await ledger()).toHaveLength(1);
      expect(await userCount()).toBe(1);
    });

    it("limits trial starts per client address across users", async () => {
      for (let n = 1; n <= 3; n++) await check(owner(n), from(`u${n}`, "203.0.113.9"));
      await expect(check(owner(4), from("u4", "203.0.113.9"))).rejects.toMatchObject({
        limit: "trial-start-network",
        message: expect.stringMatching(/network/),
      });
      expect((await check(owner(4), from("u4", "203.0.113.10"))).allowed).toBe(true);
    });

    it("keeps aggregate counters with no raw address, and drops earlier days", async () => {
      await check(owner(1), from("u1", "203.0.113.9"));
      const rows = await db.all<Record<string, unknown>>("SELECT * FROM usage_counter");
      expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
      expect(rows.map((r) => [r.scope, r.metric, r.window_start, Number(r.count)]).sort()).toEqual([
        ["network", "trial-start", "2026-09-25", 1],
        ["user", "trial-start", "2026-09-25", 1],
      ]);
      vi.setSystemTime(days(1));
      await check(owner(2), from("u1", "203.0.113.9"));
      const windows = await db.all<{ window_start: string }>("SELECT DISTINCT window_start FROM usage_counter");
      expect(windows).toEqual([{ window_start: "2026-09-26" }]);
    });
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
  });

  it("writes nothing on reads once the owner's trial entitlement has ended", async () => {
    await check(acme, reader());
    vi.setSystemTime(days(31));
    const run = vi.spyOn(db, "run");
    expect(await check(acme, reader())).toEqual({ allowed: false, reason: "trial-expired" });
    expect(run).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it.each(["converted", "expired"])(
    "counts a ledger entry with status %s as ended, whatever its expiry",
    async (status) => {
      await check(acme, reader());
      // Converted to a plan that later lapsed and was removed, or revoked by an operator.
      await db.run("UPDATE trial SET status = ?", [status]);
      await db.run("DELETE FROM entitlement");
      vi.setSystemTime(days(5));
      expect(await check(acme, reader())).toEqual({ allowed: false, reason: "trial-expired" });
      expect(await entitlements()).toEqual([]);
      expect((await ledger())[0]!.status).toBe(status);
    },
  );

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
    // What a successful publish records for each contributor.
    const active = async (userIds: string[]) => {
      const track = contributorTrackerFor(hosted, db)!;
      for (const userId of userIds) await track(acme, userId);
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

    it("counts active contributors per billing period, like the paid plans", async () => {
      const users = await Promise.all(Array.from({ length: 11 }, (_, i) => contributor(i + 1)));
      await check(acme, reader(users[0]));
      await active(users.slice(0, 10)); // in September
      vi.setSystemTime(new Date("2026-10-05T00:00:00.000Z"));
      expect((await check(acme, writer(users[10]))).allowed).toBe(true);
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
