// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRoute, withErrorLog } from "./request-log";
import { captureLogs } from "./test-utils";

afterEach(() => vi.restoreAllMocks());

describe("appRoute", () => {
  it.each([
    ["/", "/"],
    ["/health", "/health"],
    ["/frames/mermaid", "/frames/mermaid"],
    ["/github.com/acme/secret-app/pull/12", "/:host/:owner/:repo/pull/:number"],
    ["/api/github/public/github.com/repos/acme/app/pulls/1", "/api/github/public/*"],
    ["/api/github/user/github.com/repos/acme/app/pulls/1", "/api/github/user/*"],
    ["/api/github/write/github.com/acme/app/pulls/1/comment", "/api/github/write/*"],
    ["/api/auth/callback/github", "/api/auth/*"],
    ["/_serverFn/abc123", "/_serverFn/*"],
    ["/assets/index-abc.js", "/assets/*"],
    ["/acme/secret-app", "other"],
  ])("%s -> %s", (path, route) => expect(appRoute(path)).toBe(route));
});

describe("withErrorLog", () => {
  const request = new Request("https://app.example/github.com/acme/secret-app/pull/12?doc=plans.md");

  it("logs nothing for a successful response", async () => {
    const logs = captureLogs();
    await withErrorLog(request, async () => new Response("ok"));
    expect(logs.events()).toEqual([]);
  });

  it("logs a 5xx response by route template and status", async () => {
    const logs = captureLogs();
    const res = await withErrorLog(request, async () => new Response("boom", { status: 502 }));
    expect(res.status).toBe(502);
    expect(logs.events()).toEqual([
      { level: "error", event: "server.error", method: "GET", route: "/:host/:owner/:repo/pull/:number", status: 502 },
    ]);
  });

  it("logs a thrown error by class name only and rethrows it", async () => {
    const logs = captureLogs();
    const error = new SyntaxError("Unexpected token in acme/secret-app plans.md: ghu_token");
    await expect(withErrorLog(request, () => Promise.reject(error))).rejects.toBe(error);
    expect(logs.events()).toEqual([
      { level: "error", event: "server.error", method: "GET", route: "/:host/:owner/:repo/pull/:number", error: "SyntaxError" },
    ]);
    expect(logs.raw()).not.toMatch(/acme|secret|plans|ghu_/);
  });
});
