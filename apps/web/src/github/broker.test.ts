// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { forRepository } from "./broker";

const read = { host: "github.com", owner: "acme", repo: "widgets", operation: "read" } as const;
const identity = (token: string | null) => ({ getUserGitHubToken: vi.fn(async () => token) });
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
