// SPDX-License-Identifier: AGPL-3.0-only
// Billing accounts, memberships and the entitlement check, on SQLite and PostgreSQL.
import { generateKeyPairSync } from "node:crypto";
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type SqlDatabase } from "@rendered-review/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminAccounts,
  billingAccountFor,
  entitlementCheckFor,
  githubOwnerRole,
  ownerEntitlement,
  setMembershipRole,
} from "./billing";
import { upsertOwner } from "./github/installations";
import { testDatabases } from "./github/test-databases";

const now = "2026-09-25T12:00:00.000Z";
const acme = { id: "100", login: "acme", type: "Organization" } as const;
const octo = { id: "200", login: "octo", type: "User" } as const;

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

describe.each(testDatabases)("billing accounts on %s", (_, open) => {
  let db: SqlDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await open());
    await migrate(db);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await db.run("DELETE FROM billing_account");
    await db.run("DELETE FROM github_owner");
    await db.run(`DELETE FROM "user"`);
  });

  async function entitle(accountId: string, planId: string, validUntil: string | null = null) {
    await db.run(
      "INSERT INTO entitlement (billing_account_id, plan_id, source, contributor_limit, valid_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [accountId, planId, "subscription", null, validUntil, now],
    );
  }

  it("gives a personal owner an Individual account and an organization an organization account, once", async () => {
    const personal = await billingAccountFor(db, "github.com", octo);
    const organization = await billingAccountFor(db, "github.com", acme);
    expect(personal.kind).toBe("individual");
    expect(organization.kind).toBe("organization");
    expect(personal.id).not.toBe(organization.id);
    expect(await billingAccountFor(db, "github.com", octo)).toEqual(personal);
    // Same numeric ID on another host is another owner.
    expect((await billingAccountFor(db, "ghe.example.com", octo)).id).not.toBe(personal.id);
  });

  it("keeps the account and its entitlement when the owner is renamed", async () => {
    const account = await billingAccountFor(db, "github.com", acme);
    await entitle(account.id, "team");
    expect(await billingAccountFor(db, "github.com", { ...acme, login: "acme-corp" })).toEqual(account);
    expect(await db.all("SELECT login FROM github_owner WHERE github_id = ?", ["100"])).toEqual([
      { login: "acme-corp" },
    ]);
    expect(await ownerEntitlement(db, "github.com", "100")).toEqual({
      planId: "team",
      source: "subscription",
      validUntil: null,
    });
  });

  it("finds no entitlement for an owner without an account or plan", async () => {
    expect(await ownerEntitlement(db, "github.com", "100")).toBeNull();
    await billingAccountFor(db, "github.com", acme);
    expect(await ownerEntitlement(db, "github.com", "100")).toBeNull();
  });

  it("records server-owned membership roles and lists the accounts a user administers", async () => {
    await db.run(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
      ["u1", "Octo", "octo@example.com", 1, now, now],
    );
    const org = await billingAccountFor(db, "github.com", acme);
    const personal = await billingAccountFor(db, "github.com", octo);
    await setMembershipRole(db, org.id, "u1", "admin");
    await setMembershipRole(db, personal.id, "u1", "member");
    expect(await adminAccounts(db, "u1")).toEqual([
      { id: org.id, kind: "organization", host: "github.com", login: "acme" },
    ]);
    await setMembershipRole(db, personal.id, "u1", "admin");
    await setMembershipRole(db, org.id, "u1", null);
    expect(await adminAccounts(db, "u1")).toEqual([
      { id: personal.id, kind: "individual", host: "github.com", login: "octo" },
    ]);
  });

  describe("entitlement check", () => {
    const repo = (owner: typeof acme | typeof octo) => ({
      host: "github.com",
      owner: owner.login,
      name: "widgets",
      ownerId: owner.id,
      ownerType: owner.type,
    });

    it("is absent in community mode, so private repositories stay refused", () => {
      const community = loadConfig({ ...env, HOSTING_MODE: "community", ACCESS_POLICY: "all-accessible" });
      expect(entitlementCheckFor(community, db, async () => true)).toBeUndefined();
    });

    it("in hosted mode reads the repository owner's local entitlement", async () => {
      const check = entitlementCheckFor(loadConfig({ ...env, HOSTING_MODE: "hosted" }), db, async () => true)!;
      await entitle((await billingAccountFor(db, "github.com", acme)).id, "team");
      expect(await check(repo(acme))).toEqual({ allowed: true, reason: "subscription" });
      expect(await check(repo(octo))).toEqual({ allowed: false, reason: "no-entitlement" });
    });

    it("re-evaluates against the new owner after a transfer", async () => {
      const check = entitlementCheckFor(loadConfig({ ...env, HOSTING_MODE: "hosted" }), db, async () => true)!;
      await entitle((await billingAccountFor(db, "github.com", octo)).id, "individual");
      await billingAccountFor(db, "github.com", acme);
      expect(await check(repo(octo))).toEqual({ allowed: true, reason: "subscription" });
      // octo/widgets moves to acme: acme's (missing) plan decides now, not octo's Individual plan.
      expect(await check(repo(acme))).toEqual({ allowed: false, reason: "no-entitlement" });
      await entitle((await billingAccountFor(db, "github.com", acme)).id, "individual");
      expect(await check(repo(acme))).toEqual({ allowed: false, reason: "individual-plan-org-repo" });
    });

    afterEach(() => vi.restoreAllMocks());

    it("asks GitHub whether the app is installed, never the local installation tables", async () => {
      const { privateKey: appKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const config = loadConfig({ ...env, HOSTING_MODE: "hosted", GITHUB_APP_PRIVATE_KEY: appKey });
      await entitle((await billingAccountFor(db, "github.com", acme)).id, "team");
      // The tables claim an all-repositories installation for "acme", as a stale row after a missed rename would.
      await upsertOwner(db, "github.com", acme);
      await db.run(
        `INSERT INTO github_installation (id, host, github_id, owner_id, repository_selection, created_at, updated_at)
         VALUES (?, ?, ?, (SELECT id FROM github_owner WHERE host = ? AND github_id = ?), ?, ?, ?)`,
        ["i1", "github.com", "42", "github.com", "100", "all", now, now],
      );
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
      expect(await entitlementCheckFor(config, db)!(repo(acme))).toEqual({ allowed: false, reason: "not-installed" });
      expect(String(fetch.mock.calls[0]![0])).toBe("https://api.github.com/repos/acme/widgets/installation");
    });

    it("in dedicated mode follows the installation and never reads billing tables", async () => {
      const spy = { all: vi.fn(), run: vi.fn() };
      const installed = vi.fn(async () => false);
      const check = entitlementCheckFor(loadConfig({ ...env, HOSTING_MODE: "dedicated" }), spy, installed)!;
      expect(await check(repo(acme))).toEqual({ allowed: false, reason: "not-installed" });
      expect(installed).toHaveBeenCalledWith("github.com", "acme", "widgets");
      expect(spy.all).not.toHaveBeenCalled();
      expect(spy.run).not.toHaveBeenCalled();
    });
  });
});

describe("githubOwnerRole", () => {
  const respond = (status: number, body: unknown = {}) =>
    vi.fn<typeof fetch>(async () => Response.json(body, { status }));

  it("makes a personal owner the admin of their own account", async () => {
    const fetch = respond(200, { id: 200, login: "octo" });
    expect(await githubOwnerRole({ host: "github.com", token: "t", owner: octo, fetch })).toBe("admin");
    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.github.com/user");
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer t");
    expect(
      await githubOwnerRole({ host: "github.com", token: "t", owner: octo, fetch: respond(200, { id: 201 }) }),
    ).toBeNull();
  });

  it("asks GitHub for the user's organization role", async () => {
    const fetch = respond(200, { state: "active", role: "admin" });
    expect(await githubOwnerRole({ host: "github.com", token: "t", owner: acme, fetch })).toBe("admin");
    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.github.com/user/memberships/orgs/acme");
    const role = (status: number, body?: unknown) =>
      githubOwnerRole({ host: "github.com", token: "t", owner: acme, fetch: respond(status, body) });
    expect(await role(200, { state: "active", role: "member" })).toBe("member");
    expect(await role(200, { state: "active", role: "billing_manager" })).toBe("member");
    expect(await role(200, { state: "pending", role: "admin" })).toBeNull();
    expect(await role(404)).toBeNull();
    expect(await role(403)).toBeNull();
    await expect(role(500)).rejects.toThrow(/HTTP 500/);
  });
});
