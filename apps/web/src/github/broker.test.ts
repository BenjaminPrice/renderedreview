// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
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
