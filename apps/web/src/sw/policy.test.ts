// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { isStorable, isStorablePage, OFFLINE_HEADER, OFFLINE_SHELL, routeRequest, type RequestInfo } from "./policy";

const origin = "https://app.example";
const req = (url: string, init: Partial<RequestInfo> = {}): RequestInfo => ({
  method: "GET",
  mode: "cors",
  headers: new Headers(),
  url,
  ...init,
});

describe("routeRequest", () => {
  it.each([
    ["hashed asset", req(`${origin}/assets/index-abc.js`), "asset"],
    ["page navigation", req(`${origin}/o/r/pull/1`, { mode: "navigate" }), "page"],
    ["root navigation", req(`${origin}/`, { mode: "navigate" }), "page"],
    ["POST", req(`${origin}/assets/x.js`, { method: "POST" }), "bypass"],
    ["HEAD", req(`${origin}/assets/x.js`, { method: "HEAD" }), "bypass"],
    ["GitHub API", req("https://api.github.com/repos/o/r"), "bypass"],
    ["GitHub raw", req("https://raw.githubusercontent.com/o/r/sha/README.md"), "bypass"],
    ["cross-origin navigation", req("https://github.com/login", { mode: "navigate" }), "bypass"],
    ["API fetch", req(`${origin}/api/pulls/1`), "bypass"],
    [
      "API navigation (OAuth callback)",
      req(`${origin}/api/auth/callback/github?code=x`, { mode: "navigate" }),
      "bypass",
    ],
    ["server function", req(`${origin}/_serverFn/abc`), "bypass"],
    [
      "authorization header",
      req(`${origin}/assets/x.js`, { headers: new Headers({ authorization: "Bearer t" }) }),
      "bypass",
    ],
    ["other same-origin fetch", req(`${origin}/data.json`), "bypass"],
  ])("%s", (_, request, expected) => {
    expect(routeRequest(request, origin)).toBe(expected);
  });
});

const res = (
  init: { status?: number; type?: ResponseType; redirected?: boolean; cacheControl?: string; offline?: string } = {},
) => {
  const headers = new Headers();
  if (init.cacheControl) headers.set("cache-control", init.cacheControl);
  if (init.offline) headers.set(OFFLINE_HEADER, init.offline);
  return { status: init.status ?? 200, type: init.type ?? "basic", redirected: init.redirected ?? false, headers };
};

describe("isStorable", () => {
  it("stores plain and public 200 responses", () => {
    expect(isStorable(res())).toBe(true);
    expect(isStorable(res({ cacheControl: "public, max-age=60" }))).toBe(true);
  });

  it.each([
    ["private", res({ cacheControl: "private, max-age=0" })],
    ["no-store", res({ cacheControl: "no-store" })],
    ["error status", res({ status: 404 })],
    ["partial content", res({ status: 206 })],
    ["opaque", res({ type: "opaque" })],
    ["redirected", res({ redirected: true })],
  ])("refuses %s", (_, response) => {
    expect(isStorable(response)).toBe(false);
  });
});

describe("isStorablePage", () => {
  it("stores only pages the server opts in", () => {
    expect(isStorablePage(res({ offline: OFFLINE_SHELL }))).toBe(true);
    expect(isStorablePage(res({ offline: OFFLINE_SHELL, cacheControl: "public, max-age=60" }))).toBe(true);
  });

  it.each([
    ["no opt-in header", res()],
    ["public but no opt-in header", res({ cacheControl: "public, max-age=600" })],
    ["unknown opt-in value", res({ offline: "yes" })],
    ["opted in but private", res({ offline: OFFLINE_SHELL, cacheControl: "private" })],
    ["opted in but no-store", res({ offline: OFFLINE_SHELL, cacheControl: "no-store" })],
    ["opted in but error status", res({ offline: OFFLINE_SHELL, status: 500 })],
  ])("refuses %s", (_, response) => {
    expect(isStorablePage(response)).toBe(false);
  });
});
