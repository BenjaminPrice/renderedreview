// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig } from "@rendered-review/runtime";
import { describe, expect, it, vi } from "vitest";
import { entitlementCheckFor } from "../billing";
import { forRepository } from "./broker";

const read = { host: "github.com", owner: "acme", repo: "widgets", operation: "read" } as const;
const identity = (token: string | null) => ({
  getUserGitHubToken: vi.fn(async () => token),
  getUserPublicWriteToken: vi.fn(async () => null),
});
const readToken = { host: "github.com", token: "operator" };

describe("forRepository (read)", () => {
  it("uses the signed-in user's own token", async () => {
    const id = identity("user-token");
    expect(await forRepository({ ...read, userId: "u1" }, { identity: id, readToken })).toEqual({
      kind: "user",
      token: "user-token",
    });
    expect(id.getUserGitHubToken).toHaveBeenCalledWith("u1", "github.com");
  });

  it("falls back to the operator's public read token when the user has no usable token", async () => {
    expect(await forRepository({ ...read, userId: "u1" }, { identity: identity(null), readToken })).toEqual({
      kind: "operator",
      token: "operator",
    });
  });

  it("uses the operator's public read token for signed-out reads on its host only", async () => {
    expect(await forRepository(read, { readToken })).toEqual({ kind: "operator", token: "operator" });
    expect(await forRepository({ ...read, host: "ghe.example.com" }, { readToken })).toEqual({ kind: "anonymous" });
  });

  it("is anonymous with neither a user nor an operator token", async () => {
    expect(await forRepository(read, {})).toEqual({ kind: "anonymous" });
    expect(await forRepository({ ...read, userId: "u1" }, { identity: identity(null) })).toEqual({ kind: "anonymous" });
  });
});

describe("forRepository (comment, review, resolve)", () => {
  let n = 0;
  // A fresh repository name per call: visibility answers are cached per repository.
  const write = (operation: "comment" | "review" | "resolve" = "comment") =>
    ({ userId: "u1", host: "github.com", owner: "acme", repo: `widgets-${++n}`, operation }) as const;
  const repoReply = (status: number, body: object = {}) => vi.fn(async () => Response.json(body, { status }));
  const publicRepo = () => repoReply(200, { private: false, visibility: "public" });
  const writer = (appToken: string | null, publicToken: string | null) => ({
    getUserGitHubToken: vi.fn(async () => appToken),
    getUserPublicWriteToken: vi.fn(async () => publicToken),
  });

  it("uses the GitHub App user token where the app is installed", async () => {
    const installed = vi.fn(async () => true);
    const op = write("review");
    const fetch = publicRepo();
    expect(await forRepository(op, { identity: writer("app-token", "oauth-token"), installed, fetch })).toEqual({
      kind: "user",
      token: "app-token",
    });
    expect(installed).toHaveBeenCalledWith("github.com", "acme", op.repo);
    // Visibility is read with the user's own token.
    expect(new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get("authorization")).toBe(
      "Bearer app-token",
    );
  });

  it("uses the linked OAuth App token on a public repository without the app", async () => {
    const identity = writer("app-token", "oauth-token");
    const deps = { identity, installed: async () => false, fetch: publicRepo() };
    expect(await forRepository(write("resolve"), deps)).toEqual({ kind: "public-oauth", token: "oauth-token" });
    expect(identity.getUserPublicWriteToken).toHaveBeenCalledWith("u1", "github.com");
    // No installation check configured (no GitHub App private key) means not installed.
    expect(await forRepository(write(), { identity, fetch: publicRepo() })).toEqual({
      kind: "public-oauth",
      token: "oauth-token",
    });
  });

  it("asks for public-repository authorization when the OAuth App is not linked", async () => {
    const deps = { identity: writer("app-token", null), installed: async () => false, fetch: publicRepo() };
    expect(await forRepository(write(), deps)).toEqual({ kind: "needs-public-authorization" });
  });

  it("refuses private repositories, without checking the installation", async () => {
    const installed = vi.fn(async () => true);
    const fetch = repoReply(200, { private: true, visibility: "private" });
    expect(await forRepository(write(), { identity: writer("app-token", "oauth-token"), installed, fetch })).toEqual({
      kind: "private-repo-unsupported",
    });
    expect(installed).not.toHaveBeenCalled();
  });

  const acme = { id: 100, login: "acme", type: "Organization" };
  const octo = { id: 200, login: "octo", type: "User" };
  const privateRepo = (owner = acme) => repoReply(200, { private: true, visibility: "private", owner });
  const allowed = { allowed: true, reason: "subscription" } as const;

  it("refuses private repositories in community mode without touching the database", async () => {
    const db = { all: vi.fn(), run: vi.fn() };
    const config = loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" });
    const deps = { identity: writer("app-token", null), fetch: privateRepo() };
    expect(await forRepository(write(), { ...deps, entitlement: entitlementCheckFor(config, db, undefined) })).toEqual({
      kind: "private-repo-unsupported",
    });
    expect(db.all).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("uses the GitHub App user token on a private repository its owner's plan covers", async () => {
    const entitlement = vi.fn(async () => allowed);
    const op = write();
    const deps = { identity: writer("app-token", null), fetch: privateRepo(), entitlement };
    const repository = { host: "github.com", owner: "acme", name: op.repo, ownerId: "100", ownerType: "Organization" };
    // The repository comes back with the credential: a publish counts its contributor against that owner.
    expect(await forRepository(op, deps)).toEqual({ kind: "user", token: "app-token", repository });
    // The writer: a trial counts them against its contributor cap.
    expect(entitlement).toHaveBeenCalledWith(repository, { userId: "u1", operation: "write" });
  });

  it("refuses a private repository its owner's plan does not cover, with the reason", async () => {
    const entitlement = async () => ({ allowed: false, reason: "individual-plan-org-repo" }) as const;
    const deps = { identity: writer("app-token", null), fetch: privateRepo(), entitlement };
    expect(await forRepository(write(), deps)).toEqual({ kind: "not-entitled", reason: "individual-plan-org-repo" });
  });

  it("never reveals the owner's plan to a user GitHub would not show the repository", async () => {
    const entitlement = vi.fn(async () => ({ allowed: false, reason: "no-entitlement" }) as const);
    const op = write();
    const fetch = vi.fn(async (_: string, init: RequestInit) =>
      new Headers(init.headers).get("authorization") === "Bearer token-a"
        ? Response.json({ private: true, visibility: "private", owner: acme })
        : Response.json({ message: "Not Found" }, { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    expect(await forRepository(op, { identity: writer("token-a", null), fetch, entitlement })).toMatchObject({
      kind: "not-entitled",
    });
    // A's answer is cached; B still gets what GitHub tells B.
    expect(await forRepository(op, { identity: writer("token-b", null), fetch, entitlement })).toEqual({
      kind: "unavailable",
      status: 404,
    });
    expect(entitlement).toHaveBeenCalledOnce();
  });

  it("judges a transferred repository by its new owner", async () => {
    const entitlement = vi.fn(async (r: { ownerId: string }) =>
      r.ownerId === "100" ? allowed : ({ allowed: false, reason: "no-entitlement" } as const),
    );
    const identity = writer("app-token", null);
    const before = write();
    expect(await forRepository(before, { identity, fetch: privateRepo(acme), entitlement })).toMatchObject({
      kind: "user",
    });
    const after = { ...before, owner: "octo" };
    expect(await forRepository(after, { identity, fetch: privateRepo(octo), entitlement })).toEqual({
      kind: "not-entitled",
      reason: "no-entitlement",
    });
    expect(entitlement).toHaveBeenLastCalledWith(
      expect.objectContaining({ owner: "octo", ownerId: "200" }),
      expect.anything(),
    );
  });

  it("asks the user to sign in again without a usable GitHub App token", async () => {
    const deps = { installed: async () => true, fetch: publicRepo() };
    expect(await forRepository(write(), { ...deps, identity: writer(null, "oauth-token") })).toEqual({
      kind: "reauth",
    });
    expect(await forRepository(write(), { ...deps, identity: writer("expired", null), fetch: repoReply(401) })).toEqual(
      {
        kind: "reauth",
      },
    );
  });

  it("reports a repository GitHub will not show the user", async () => {
    const deps = { identity: writer("app-token", "oauth-token"), installed: async () => true, fetch: repoReply(404) };
    expect(await forRepository(write(), deps)).toEqual({ kind: "unavailable", status: 404 });
  });
});
