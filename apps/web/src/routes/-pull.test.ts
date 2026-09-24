// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from "@tanstack/react-query";
import { isNotFound } from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { withPublicGitHub } from "../github/client";
import { allowedHostsQuery, Route } from "./$host.$owner.$repo.pull.$number";

afterEach(() => vi.unstubAllGlobals());

function loader(proxyFirst: string[] = []) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(allowedHostsQuery.queryKey, { hosts: ["github.com", "ghe.example.com"], proxyFirst });
  return (host: string) =>
    // Only params and context are read.
    (Route.options.loader as (ctx: unknown) => Promise<void>)({
      params: { host, owner: "a", repo: "b", number: 1 },
      context: { queryClient },
    }).catch((e: unknown) => e);
}

it("rejects GitHub hosts this deployment does not serve", async () => {
  const load = loader();
  expect(await load("github.com")).toBeUndefined();
  expect(await load("ghe.example.com")).toBeUndefined();
  const error = await load("evil.example.com");
  expect(isNotFound(error)).toBe(true);
  expect(error).toMatchObject({ data: { unsupportedHost: "evil.example.com" } });
});

it("reads through the proxy first only where the server has a read token", async () => {
  const fetch = vi.fn(async () => Response.json({ sha: "t", truncated: false, tree: [] }));
  vi.stubGlobal("fetch", fetch);
  await loader(["ghe.example.com"])("ghe.example.com");
  const tree = (host: string) => withPublicGitHub(host, (c) => c.getTree("a", "b", "c".repeat(40)));
  await tree("github.com");
  await tree("ghe.example.com");
  expect(fetch.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([
    `https://api.github.com/repos/a/b/git/trees/${"c".repeat(40)}`,
    `/api/github/public/ghe.example.com/repos/a/b/git/trees/${"c".repeat(40)}`,
  ]);
});
