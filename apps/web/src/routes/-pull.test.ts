// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from "@tanstack/react-query";
import { isNotFound } from "@tanstack/react-router";
import { expect, it } from "vitest";
import { allowedHostsQuery, Route } from "./$host.$owner.$repo.pull.$number";

it("rejects GitHub hosts this deployment does not serve", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(allowedHostsQuery.queryKey, ["github.com", "ghe.example.com"]);
  const load = (host: string) =>
    // Only params and context are read.
    (Route.options.loader as (ctx: unknown) => Promise<void>)({
      params: { host, owner: "a", repo: "b", number: 1 },
      context: { queryClient },
    }).catch((e: unknown) => e);

  expect(await load("github.com")).toBeUndefined();
  expect(await load("ghe.example.com")).toBeUndefined();
  const error = await load("evil.example.com");
  expect(isNotFound(error)).toBe(true);
  expect(error).toMatchObject({ data: { unsupportedHost: "evil.example.com" } });
});
