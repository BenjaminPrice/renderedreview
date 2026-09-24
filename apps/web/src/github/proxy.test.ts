// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig } from "@rendered-review/runtime";
import { describe, expect, it, vi } from "vitest";
import { allowedHosts, proxyFirstHosts, proxyPublicGitHub } from "./proxy";

const OID = "a".repeat(40);
const origin = "https://app.example";

function setup(response = new Response("{}", { status: 200, headers: { etag: '"e"', "set-cookie": "x=1" } })) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response.clone());
  const call = (path: string, init?: RequestInit) =>
    proxyPublicGitHub(new Request(`${origin}/api/github/public/${path}`, init), {
      allowedHosts: ["github.com", "ghe.example.com:8443"],
      fetch,
    });
  return { fetch, call };
}

describe("allowedHosts", () => {
  const hosts = (GITHUB_URL?: string) =>
    allowedHosts(loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled", GITHUB_URL }));
  it("always allows github.com", () => expect(hosts()).toEqual(["github.com"]));
  it("adds the configured Enterprise Server host", () =>
    expect(hosts("https://GHE.example.com:8443/")).toEqual(["github.com", "ghe.example.com:8443"]));
});

it("prefers the proxy only for the host the server token belongs to", () => {
  const hosts = (env: Record<string, string>) =>
    proxyFirstHosts(loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled", ...env }));
  expect(hosts({})).toEqual([]);
  expect(hosts({ GITHUB_PUBLIC_READ_TOKEN: "t" })).toEqual(["github.com"]);
  expect(hosts({ GITHUB_PUBLIC_READ_TOKEN: "t", GITHUB_URL: "https://ghe.example.com" })).toEqual(["ghe.example.com"]);
});

describe("proxyPublicGitHub", () => {
  it.each([
    ["github.com/repos/acme/widgets/pulls/1", "mutable"],
    ["github.com/repos/acme/widgets/pulls/1/files?per_page=100&page=2", "mutable"],
    ["github.com/repos/acme/widgets/pulls/1/comments", "mutable"],
    ["github.com/repos/acme/widgets/pulls/1/reviews", "mutable"],
    ["github.com/repos/acme/widgets/issues/1/comments", "mutable"],
    ["github.com/repositories/42/pulls/1/files?per_page=100&page=3", "mutable"],
    [`github.com/repos/acme/widgets/git/trees/${OID}?recursive=1`, "immutable"],
    [`github.com/repos/acme/widgets/git/blobs/${OID}`, "immutable"],
    [`github.com/repos/acme/widgets/contents/docs/a%20b.md?ref=${OID}`, "immutable"],
  ])("forwards %s anonymously", async (path, kind) => {
    const { fetch, call } = setup();
    const res = await call(path, { headers: { authorization: "Bearer secret", cookie: "s=1" } });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.github.com/${path.slice("github.com/".length)}`);
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(res.headers.get("cache-control")).toBe(
      kind === "immutable" ? "public, max-age=31536000, immutable" : "public, max-age=30, must-revalidate",
    );
    expect(res.headers.get("etag")).toBe('"e"');
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    "github.com/user",
    "github.com/repos/acme/widgets",
    "github.com/repos/acme/widgets/contents/README.md",
    "github.com/repos/acme/widgets/contents/README.md?ref=main",
    `github.com/repos/acme/widgets/contents/README.md?ref=${OID}&per_page=1`,
    `github.com/repos/acme/widgets/contents/README.md?ref=${OID}&ref=main`,
    `github.com/repos/acme/widgets/contents/%2e%2e/%2E%2E/%2e%2e/user?ref=${OID}`,
    `github.com/repos/acme/widgets/contents/docs%2F..%2F..%2Fpulls?ref=${OID}`,
    `github.com/repos/acme/widgets/contents/?ref=${OID}`,
    `github.com/repos/acme/widgets/git/blobs/${OID}?ref=${OID}`,
    "github.com/repos/acme/widgets/pulls/1/merge",
    "github.com/repos/acme/widgets/git/trees/main",
    "github.com/repos/acme/widgets/git/blobs/abc",
    "github.com/repos/acme/widgets/pulls/1?access_token=x",
    "github.com/repos/acme/widgets/pulls/1?per_page=abc",
    "github.com/repos/../widgets/pulls/1",
    "github.com/repos/acme/widgets/pulls/1/files/../../../../user",
    "github.com/graphql",
    "evil.example.com/repos/acme/widgets/pulls/1",
    "ghe.example.com/repos/acme/widgets/pulls/1",
    "api.github.com/repos/acme/widgets/pulls/1",
    "github.com",
  ])("rejects %s", async (path) => {
    const { fetch, call } = setup();
    const res = await call(path);
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards to an allowed Enterprise Server host", async () => {
    const { fetch, call } = setup();
    expect((await call("ghe.example.com:8443/repos/acme/widgets/pulls/1")).status).toBe(200);
    expect(fetch.mock.calls[0]![0]).toBe("https://ghe.example.com:8443/api/v3/repos/acme/widgets/pulls/1");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects %s", async (method) => {
    const { fetch, call } = setup();
    expect((await call("github.com/repos/acme/widgets/pulls/1", { method })).status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards conditional requests and passes 304 through", async () => {
    const { fetch, call } = setup(new Response(null, { status: 304, headers: { etag: '"e"' } }));
    const res = await call("github.com/repos/acme/widgets/pulls/1", { headers: { "if-none-match": '"e"' } });
    expect(fetch.mock.calls[0]![1]?.headers).toHaveProperty("If-None-Match", '"e"');
    expect(res.status).toBe(304);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30, must-revalidate");
  });

  it("does not cache upstream errors", async () => {
    const { call } = setup(new Response('{"message":"Not Found"}', { status: 404 }));
    const res = await call(`github.com/repos/acme/widgets/git/blobs/${OID}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("proxyPublicGitHub with a server read token", () => {
  // Each test uses its own repository: visibility is cached per host and repository.
  function setupWithToken(repo: Response | (() => Promise<Response>)) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (/\/repos\/[^/]+\/[^/]+$|\/repositories\/\d+$/.test(String(input)))
        return repo instanceof Response ? repo.clone() : repo();
      return Response.json({}, { headers: { etag: '"e"', "x-ratelimit-limit": "5000" } });
    });
    const call = (path: string, init?: RequestInit) =>
      proxyPublicGitHub(new Request(`${origin}/api/github/public/${path}`, init), {
        allowedHosts: ["github.com", "ghe.example.com"],
        readToken: { host: "github.com", token: "server-token" },
        fetch,
      });
    const auth = (i: number) => (fetch.mock.calls[i]![1]?.headers as Record<string, string>).Authorization;
    return { fetch, call, auth };
  }
  const publicRepo = () => Response.json({ private: false, visibility: "public" });

  it("confirms the repository is public, then forwards with the server token only", async () => {
    const { fetch, call, auth } = setupWithToken(publicRepo());
    const res = await call(`github.com/repos/acme/open/git/blobs/${OID}`, {
      headers: { authorization: "Bearer client", cookie: "s=1" },
    });
    expect(res.status).toBe(200);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://api.github.com/repos/acme/open",
      `https://api.github.com/repos/acme/open/git/blobs/${OID}`,
    ]);
    expect([auth(0), auth(1)]).toEqual(["Bearer server-token", "Bearer server-token"]);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("client");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-ratelimit-limit")).toBe("5000");
  });

  it("caches the visibility per repository", async () => {
    const { fetch, call } = setupWithToken(publicRepo());
    await call("github.com/repos/acme/cached/pulls/1");
    await call("github.com/repos/ACME/Cached/pulls/1/files");
    await call("github.com/repositories/42/pulls/1");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://api.github.com/repos/acme/cached",
      "https://api.github.com/repos/acme/cached/pulls/1",
      "https://api.github.com/repos/ACME/Cached/pulls/1/files",
      "https://api.github.com/repositories/42",
      "https://api.github.com/repositories/42/pulls/1",
    ]);
  });

  it.each([
    ["private", () => Promise.resolve(Response.json({ private: true, visibility: "private" }))],
    ["internal", () => Promise.resolve(Response.json({ private: true, visibility: "internal" }))],
    ["missing", () => Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }))],
    ["rate-limited", () => Promise.resolve(Response.json({ message: "limit" }, { status: 403 }))],
    ["unreachable", () => Promise.reject(new TypeError("fetch failed"))],
  ])("answers not found when the repository is %s", async (name, repo) => {
    const { fetch, call } = setupWithToken(repo);
    const res = await call(`github.com/repos/acme/${name}/pulls/1`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never sends the token to another host", async () => {
    const { fetch, call } = setupWithToken(publicRepo());
    expect((await call("ghe.example.com/repos/acme/other/pulls/1")).status).toBe(200);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["https://ghe.example.com/api/v3/repos/acme/other/pulls/1"]);
    expect(fetch.mock.calls[0]![1]?.headers).not.toHaveProperty("Authorization");
  });
});
