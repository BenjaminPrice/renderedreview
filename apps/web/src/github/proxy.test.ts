// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { proxyPublicGitHub } from "./proxy";

const OID = "a".repeat(40);
const origin = "https://app.example";

function setup(response = new Response("{}", { status: 200, headers: { etag: '"e"', "set-cookie": "x=1" } })) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response.clone());
  const call = (path: string, init?: RequestInit) =>
    proxyPublicGitHub(new Request(`${origin}/api/github/public/${path}`, init), { fetch });
  return { fetch, call };
}

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
    "github.com/repos/acme/widgets/pulls/1/merge",
    "github.com/repos/acme/widgets/git/trees/main",
    "github.com/repos/acme/widgets/git/blobs/abc",
    "github.com/repos/acme/widgets/pulls/1?access_token=x",
    "github.com/repos/acme/widgets/pulls/1?per_page=abc",
    "github.com/repos/../widgets/pulls/1",
    "github.com/repos/acme/widgets/pulls/1/files/../../../../user",
    "github.com/graphql",
    "evil.example.com/repos/acme/widgets/pulls/1",
    "api.github.com/repos/acme/widgets/pulls/1",
    "github.com",
  ])("rejects %s", async (path) => {
    const { fetch, call } = setup();
    const res = await call(path);
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
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
