// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from "vitest";
import { browserCache } from "./client";
import { blobQuery, changedFilesQuery, type PrIdentity, pullRequestQuery, reviewThreadsQuery } from "./queries";

afterEach(() => vi.unstubAllGlobals());

it("serves immutable blobs from the object store after the first fetch", async () => {
  const fetch = vi.fn(async () => new Response("# Hello"));
  vi.stubGlobal("fetch", fetch);
  const id = { host: "blob.example.com", repositoryId: 1, owner: "a", repo: "b" } as PrIdentity;
  const query = blobQuery(id, "b".repeat(40));
  const run = () => (query.queryFn as () => Promise<string>)();

  expect(await run()).toBe("# Hello");
  expect(await run()).toBe("# Hello");
  expect(fetch).toHaveBeenCalledOnce();
});

it("keys signed-in and signed-out data apart", () => {
  const params = { host: "github.com", owner: "A", repo: "B", number: 1 };
  expect(pullRequestQuery(params, "user").queryKey).not.toEqual(pullRequestQuery(params, "public").queryKey);
  const id = (access: "user" | "public") => ({ host: "github.com", repositoryId: 1, number: 1, access }) as PrIdentity;
  expect(changedFilesQuery(id("user")).queryKey).not.toEqual(changedFilesQuery(id("public")).queryKey);
  expect(blobQuery(id("user"), "b").queryKey).not.toEqual(blobQuery(id("public"), "b").queryKey);
});

it("keeps immutable content read with the user's access private", async () => {
  vi.stubGlobal("fetch", async () => new Response("# Private"));
  const set = vi.spyOn(browserCache, "set");
  const id = { host: "github.com", repositoryId: 2, owner: "a", repo: "b", access: "user" } as PrIdentity;
  await (blobQuery(id, "c".repeat(40)).queryFn as () => Promise<string>)();
  expect(set).toHaveBeenCalledWith("objects", expect.any(String), "# Private", { private: true });
  set.mockRestore();
});

it("reads review threads only with the user's access", async () => {
  const fetch = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetch);
  const id = (access: "user" | "public") =>
    ({ host: "github.com", repositoryId: 3, owner: "a", repo: "b", number: 4, access }) as PrIdentity;
  expect(reviewThreadsQuery(id("public")).enabled).toBe(false);
  expect(reviewThreadsQuery(id("user")).enabled).toBe(true);
  await (reviewThreadsQuery(id("user")).queryFn as () => Promise<unknown>)();
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
    "/api/github/user/github.com/repos/a/b/pulls/4/review-threads",
  );
});
