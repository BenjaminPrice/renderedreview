// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from "vitest";
import { blobQuery, type PrIdentity } from "./queries";

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
