// SPDX-License-Identifier: AGPL-3.0-only
import { ForbiddenError, NetworkError, NotFoundError, RateLimitError } from "@rendered-review/github-integration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackReason, preferProxy, proxiedFetch, withPublicGitHub } from "./client";

describe("fallbackReason", () => {
  it("falls back on network/CORS failures and rate limits only", () => {
    expect(fallbackReason(new NetworkError("u", new TypeError("Failed to fetch")))).toBe("network");
    expect(fallbackReason(new RateLimitError("limit", 403, "u", undefined, new Date()))).toBe("rate-limit");
    expect(fallbackReason(new NotFoundError("nf", 404, "u"))).toBeUndefined();
    expect(fallbackReason(new ForbiddenError("f", 403, "u"))).toBeUndefined();
    expect(fallbackReason(new Error("x"))).toBeUndefined();
  });
});

it("proxiedFetch rewrites GitHub API URLs to the same-origin proxy", async () => {
  const inner = vi.fn(async () => new Response());
  await proxiedFetch("github.com", inner)("https://api.github.com/repositories/1/pulls/2/files?page=2");
  await proxiedFetch("ghe.example.com", inner)("https://ghe.example.com/api/v3/repos/a/b/pulls/1");
  expect(inner.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
    "/api/github/public/github.com/repositories/1/pulls/2/files?page=2",
    "/api/github/public/ghe.example.com/repos/a/b/pulls/1",
  ]);
});

const TREE = { sha: "t", truncated: false, tree: [] };
const OID = "a".repeat(40);

describe("withPublicGitHub", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Each test uses its own host: clients (and their sticky fallback state) are per host.
  function stubFetch(direct: () => Response | Promise<Response>) {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/") ? Response.json(TREE) : direct(),
    );
    vi.stubGlobal("fetch", fetch);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const urls = () => fetch.mock.calls.map((c) => String(c[0]));
    return { urls, info };
  }
  const getTree = (host: string) =>
    withPublicGitHub(host, async (c) => (await c.getTree("a", "b", OID)) && "ok").catch((e) => e);

  it("uses the direct response when it succeeds", async () => {
    const { urls, info } = stubFetch(() => Response.json(TREE));
    expect(await getTree("direct.example.com")).toBe("ok");
    expect(urls()).toEqual([`https://direct.example.com/api/v3/repos/a/b/git/trees/${OID}`]);
    expect(info).not.toHaveBeenCalled();
  });

  it("retries through the proxy on a network (CORS) failure and logs only the category", async () => {
    const { urls, info } = stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await getTree("cors.example.com");
    expect(urls()).toEqual([
      `https://cors.example.com/api/v3/repos/a/b/git/trees/${OID}`,
      `/api/github/public/cors.example.com/repos/a/b/git/trees/${OID}`,
    ]);
    expect(info).toHaveBeenCalledWith("github public fallback: network");
  });

  it("switches to the proxy until the rate limit resets", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    const { urls, info } = stubFetch(() =>
      Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
        },
      ),
    );
    await getTree("limited.example.com");
    await getTree("limited.example.com");
    expect(urls()).toEqual([
      `https://limited.example.com/api/v3/repos/a/b/git/trees/${OID}`,
      `/api/github/public/limited.example.com/repos/a/b/git/trees/${OID}`,
      `/api/github/public/limited.example.com/repos/a/b/git/trees/${OID}`,
    ]);
    expect(info).toHaveBeenCalledExactlyOnceWith("github public fallback: rate-limit");
  });

  it("revalidates through the shared response cache", async () => {
    let calls = 0;
    const { urls } = stubFetch(() =>
      calls++ ? new Response(null, { status: 304 }) : Response.json(TREE, { headers: { etag: '"t"' } }),
    );
    expect(await getTree("etag.example.com")).toBe("ok");
    expect(await getTree("etag.example.com")).toBe("ok");
    expect(urls()).toHaveLength(2);
    const fetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(new Headers(fetch.mock.calls[1]![1].headers).get("if-none-match")).toBe('"t"');
  });

  it("goes straight to the proxy for a host the server reads with a token", async () => {
    const { urls } = stubFetch(() => Response.json(TREE));
    preferProxy("token.example.com");
    expect(await getTree("token.example.com")).toBe("ok");
    expect(urls()).toEqual([`/api/github/public/token.example.com/repos/a/b/git/trees/${OID}`]);
  });

  it("does not fall back on 404", async () => {
    const { urls } = stubFetch(() => Response.json({ message: "Not Found" }, { status: 404 }));
    expect(await getTree("missing.example.com")).toBeInstanceOf(NotFoundError);
    expect(urls()).toHaveLength(1);
  });
});
