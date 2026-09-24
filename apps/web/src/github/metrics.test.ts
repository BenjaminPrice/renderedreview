// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRoute, meteredFetch } from "./metrics";

const OID = "0123456789abcdef0123456789abcdef01234567";

afterEach(() => vi.restoreAllMocks());

describe("githubRoute", () => {
  it.each([
    ["https://api.github.com/repos/acme/secret-app/pulls/12/files?page=2", "/repos/:/:/pulls/:/files"],
    [`https://ghe.example.com/api/v3/repos/acme/app/git/blobs/${OID}`, "/repos/:/:/git/blobs/:"],
    [`https://api.github.com/repos/acme/app/contents/docs/pulls/plan.md?ref=${OID}`, "/repos/:/:/contents/*"],
    ["https://api.github.com/repositories/123/issues/4/comments", "/repositories/:/issues/:/comments"],
    ["https://api.github.com/graphql", "/graphql"],
    ["https://ghe.example.com/api/graphql", "/graphql"],
    ["https://api.github.com/user/installations", "/user/installations"],
    // A repository named like an endpoint is still a placeholder.
    ["https://api.github.com/repos/pulls/comments/pulls/1", "/repos/:/:/pulls/:"],
  ])("%s -> %s", (url, route) => {
    expect(githubRoute(url)).toBe(route);
  });
});

describe("meteredFetch", () => {
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([l]) => JSON.parse(String(l)) as object);

  it("logs host, route template, status, duration and remaining rate limit, never owner or repo", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetch = meteredFetch(async () =>
      Response.json({}, { status: 200, headers: { "x-ratelimit-remaining": "4999" } }),
    );
    const res = await fetch("https://api.github.com/repos/acme/secret-app/pulls/12", {
      headers: { authorization: "Bearer ghu_secret" },
    });
    expect(res.status).toBe(200);
    expect(lines(info)).toEqual([
      {
        level: "info",
        event: "github.request",
        host: "api.github.com",
        method: "GET",
        route: "/repos/:/:/pulls/:",
        status: 200,
        durationMs: expect.any(Number),
        rateLimitRemaining: 4999,
        outcome: "ok",
      },
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/acme|secret/);
  });

  it("warns on GitHub errors and rate limits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = meteredFetch(async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    await fetch(new Request("https://api.github.com/graphql", { method: "POST", body: "{}" }));
    expect(lines(warn)).toEqual([expect.objectContaining({ route: "/graphql", method: "POST", status: 403, outcome: "error", rateLimitRemaining: 0 })]);
  });

  it("logs a network failure by error class and rethrows it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new TypeError("fetch failed: https://api.github.com/repos/acme/app");
    const fetch = meteredFetch(async () => Promise.reject(failure));
    await expect(fetch("https://api.github.com/repos/acme/app")).rejects.toBe(failure);
    expect(lines(warn)).toEqual([expect.objectContaining({ status: 0, outcome: "network", error: "TypeError" })]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/acme/);
  });
});
