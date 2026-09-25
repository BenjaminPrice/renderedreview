// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig } from "@rendered-review/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entitlementCheckFor, type EntitlementCheck } from "../billing";
import { RateLimited } from "../rate-limit";
import { captureLogs } from "../test-utils";
import { proxyUserGitHub, TRIAL_ENDS_HEADER, TRIAL_EXPIRED, USER_PREFIX } from "./user-proxy";

const PLANS = "https://renderedreview.com/pricing";

const OID = "a".repeat(40);
const origin = "https://app.example";
const user = { id: "u1", login: "octocat", avatarUrl: null };
const XRW = { "x-requested-with": "rendered-review" };

type Upstream = (url: string, init?: RequestInit) => Response | Promise<Response>;
const publicRepo = () => Response.json({ private: false, visibility: "public" });

// Each test uses its own repository name: visibility is cached per host and repository.
function setup({
  session = user as typeof user | null,
  token = "user-token" as string | null,
  upstream = (() => Response.json({}, { headers: { etag: '"e"', "set-cookie": "x=1" } })) as Upstream,
  entitlement = undefined as EntitlementCheck | undefined,
  clientAddress = undefined as string | undefined,
  /** null: the deployment hides the link. */
  upgradeUrl = PLANS as string | null,
} = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return publicRepo();
    return upstream(url, init);
  });
  const identity = {
    getSessionUser: vi.fn(async () => session),
    getUserGitHubToken: vi.fn(async () => token),
  };
  const call = (path: string, init: RequestInit = {}) =>
    proxyUserGitHub(new Request(`${origin}${USER_PREFIX}${path}`, { ...init, headers: { ...XRW, ...init.headers } }), {
      allowedHosts: ["github.com"],
      identity,
      fetch,
      entitlement,
      clientAddress,
      upgradeUrl: upgradeUrl ?? undefined,
    });
  const auth = (i: number) => (fetch.mock.calls[i]![1]?.headers as Record<string, string>).Authorization;
  return { fetch, identity, call, auth };
}

const body = async (res: Response) => (await res.json()) as { code?: string };

afterEach(() => vi.restoreAllMocks());

describe("proxyUserGitHub", () => {
  it("forwards an allowlisted read with the user's token, never shared-cacheable", async () => {
    const { fetch, call, auth } = setup();
    const res = await call("github.com/repos/acme/one/pulls/1", {
      headers: { authorization: "Bearer client", cookie: "session=s" },
    });
    expect(res.status).toBe(200);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://api.github.com/repos/acme/one",
      "https://api.github.com/repos/acme/one/pulls/1",
    ]);
    expect([auth(0), auth(1)]).toEqual(["Bearer user-token", "Bearer user-token"]);
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/client|session=s/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toMatch(/Cookie/);
    expect(res.headers.get("etag")).toBe('"e"');
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("reads a pull request's commits", async () => {
    const { fetch, call } = setup();
    expect((await call("github.com/repos/acme/one/pulls/1/commits?per_page=100")).status).toBe(200);
    expect(fetch.mock.calls.at(-1)![0]).toBe("https://api.github.com/repos/acme/one/pulls/1/commits?per_page=100");
  });

  it("keeps immutable content private too", async () => {
    const { call } = setup();
    const res = await call(`github.com/repos/acme/two/git/blobs/${OID}`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires a session: 401 without a redirect", async () => {
    const { fetch, call } = setup({ session: null });
    const res = await call("github.com/repos/acme/three/pulls/1");
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ code: "unauthenticated" });
    expect(res.headers.get("location")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the user to sign in again when their GitHub token cannot be refreshed", async () => {
    const { fetch, call } = setup({ token: null });
    const res = await call("github.com/repos/acme/four/pulls/1");
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ code: "reauth" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the user to sign in again when GitHub rejects their token", async () => {
    const { call } = setup({ upstream: () => Response.json({ message: "Bad credentials" }, { status: 401 }) });
    const res = await call("github.com/repos/acme/five/pulls/1");
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ code: "reauth" });
  });

  it("refuses private repositories without reading their content", async () => {
    const { fetch, identity, call } = setup();
    fetch.mockImplementation(async () => Response.json({ private: true, visibility: "private" }));
    const res = await call("github.com/repos/acme/secret/pulls/1");
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "private-repo-unsupported" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(identity.getUserGitHubToken).toHaveBeenCalledWith("u1", "github.com");
  });

  describe("private repositories", () => {
    const privateRepo = () =>
      Response.json({
        id: 4242,
        private: true,
        visibility: "private",
        owner: { id: 100, login: "acme", type: "Organization" },
      });
    const withPrivate = (
      entitlement: EntitlementCheck | undefined,
      upgradeUrl: string | null = PLANS,
      clientAddress?: string,
    ) => {
      const t = setup({ entitlement, upgradeUrl, clientAddress });
      const upstream = t.fetch.getMockImplementation()!;
      t.fetch.mockImplementation(async (input, init) =>
        /\/repos\/[^/]+\/[^/]+$/.test(String(input)) ? privateRepo() : upstream(input, init),
      );
      return t;
    };

    it("stay refused in community mode, and billing tables are never read", async () => {
      const db = { all: vi.fn(), run: vi.fn() };
      const config = loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" });
      const { fetch, call } = withPrivate(entitlementCheckFor(config, db, async () => true));
      const res = await call("github.com/repos/acme/community/pulls/1");
      expect(res.status).toBe(403);
      expect(await body(res)).toMatchObject({ code: "private-repo-unsupported" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(db.all).not.toHaveBeenCalled();
      expect(db.run).not.toHaveBeenCalled();
    });

    it("are served when the owner's plan covers them", async () => {
      const entitlement = vi.fn<EntitlementCheck>(async () => ({ allowed: true, reason: "subscription" }));
      const { fetch, call } = withPrivate(entitlement);
      const res = await call("github.com/repos/acme/covered/pulls/1");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(fetch.mock.calls.at(-1)![0]).toBe("https://api.github.com/repos/acme/covered/pulls/1");
      expect(entitlement).toHaveBeenCalledWith(
        { host: "github.com", owner: "acme", name: "covered", ownerId: "100", ownerType: "Organization" },
        // The signed-in reader: their first private read may start the owner's trial.
        { userId: "u1", operation: "read" },
      );
      expect(res.headers.get(TRIAL_ENDS_HEADER)).toBeNull();
    });

    it("answer a typed 429 when starting the owner's trial is over the daily limit", async () => {
      const entitlement = vi.fn<EntitlementCheck>(async () => {
        throw new RateLimited("trial-start", 3600);
      });
      const { fetch, call } = withPrivate(entitlement, PLANS, "198.51.100.7");
      const res = await call("github.com/repos/acme/throwaway/pulls/1");
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("3600");
      expect(res.headers.get("vary")).toBe("Cookie");
      expect(await res.json()).toMatchObject({ code: "rate-limited", retryAfter: 3600 });
      // The trusted address reaches the check (for the per-address limit); nothing is read upstream.
      expect(entitlement.mock.calls[0]![1]).toEqual({ userId: "u1", operation: "read", clientAddress: "198.51.100.7" });
      expect(fetch).toHaveBeenCalledOnce();
    });

    it("carry a running trial's end for the days-left indicator", async () => {
      const validUntil = "2026-10-25T12:00:00.000Z";
      const { call } = withPrivate(async () => ({ allowed: true, reason: "trial", validUntil }));
      const res = await call("github.com/repos/acme/trialing/pulls/1");
      expect(res.status).toBe(200);
      expect(res.headers.get(TRIAL_ENDS_HEADER)).toBe(validUntil);
    });

    it("are refused with the upgrade path once the owner's trial has ended", async () => {
      const { call } = withPrivate(async () => ({ allowed: false, reason: "trial-expired" }));
      const res = await call("github.com/repos/acme/ended/pulls/1");
      expect(res.status).toBe(403);
      // The repository ID (GitHub just showed it to this viewer) lets the page find this PR's drafts.
      expect(await res.json()).toEqual({
        code: "trial-expired",
        message: TRIAL_EXPIRED,
        upgradeUrl: PLANS,
        repositoryId: 4242,
      });
    });

    it("leave the upgrade path out when the deployment hides it", async () => {
      const { call } = withPrivate(async () => ({ allowed: false, reason: "trial-expired" }), null);
      const res = await call("github.com/repos/acme/ended/pulls/1");
      expect(res.status).toBe(403);
      expect(await res.json()).not.toHaveProperty("upgradeUrl");
    });

    it("are refused with the reason when the owner's plan does not cover them", async () => {
      const { fetch, call } = withPrivate(async () => ({ allowed: false, reason: "no-entitlement" }));
      const res = await call("github.com/repos/acme/uncovered/pulls/1");
      expect(res.status).toBe(403);
      expect(await body(res)).toMatchObject({ code: "not-entitled", reason: "no-entitlement" });
      expect(fetch).toHaveBeenCalledOnce();
    });

    it("never reveal the owner's plan to a viewer GitHub would not show the repository", async () => {
      const entitlement = vi.fn<EntitlementCheck>(async () => ({ allowed: false, reason: "no-entitlement" }));
      // GitHub shows the repository to viewer A only; B gets its 404.
      const fetch = vi.fn<typeof globalThis.fetch>(async (_, init) =>
        (init?.headers as Record<string, string>).Authorization === "Bearer token-a"
          ? privateRepo()
          : Response.json({ message: "Not Found" }, { status: 404 }),
      );
      const as = (token: string) =>
        proxyUserGitHub(new Request(`${origin}${USER_PREFIX}github.com/repos/acme/shared/pulls/1`, { headers: XRW }), {
          allowedHosts: ["github.com"],
          identity: { getSessionUser: async () => user, getUserGitHubToken: async () => token },
          fetch,
          entitlement,
        });
      expect(await body(await as("token-a"))).toMatchObject({ code: "not-entitled" });
      // A's answer is cached; B must still get GitHub's own 404, never the plan status.
      const res = await as("token-b");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: "Not Found" });
      expect(entitlement).toHaveBeenCalledOnce();
    });
  });

  it("passes GitHub's answer through when the repository lookup fails", async () => {
    const { fetch, call } = setup();
    fetch.mockImplementation(async () => Response.json({ message: "Not Found" }, { status: 404 }));
    const res = await call("github.com/repos/acme/gone/pulls/1");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reads a file at a commit OID, raw", async () => {
    const { fetch, call } = setup();
    const path = `github.com/repos/acme/three/contents/docs/index.md?ref=${OID}`;
    const res = await call(path, { headers: { accept: "application/vnd.github.raw+json" } });
    expect(res.status).toBe(200);
    expect(fetch.mock.calls[1]![0]).toBe(`https://api.github.com/repos/acme/three/contents/docs/index.md?ref=${OID}`);
    expect(fetch.mock.calls[1]![1]?.headers).toHaveProperty("Accept", "application/vnd.github.raw+json");
  });

  it("forwards a file path re-encoded from the validated names", async () => {
    const { fetch, call } = setup();
    await call(`github.com/repos/acme/four/contents/notes/caf%c3%a9 (1).md?ref=${OID}`);
    expect(fetch.mock.calls[1]![0]).toBe(
      `https://api.github.com/repos/acme/four/contents/notes/caf%C3%A9%20(1).md?ref=${OID}`,
    );
  });

  it.each([
    "github.com/user",
    "github.com/repos/acme/x/contents/README.md",
    "github.com/repos/acme/x/contents/README.md?ref=main",
    `github.com/repos/acme/x/contents/%2e%2e/%2e%2e/user?ref=${OID}`,
    `github.com/repos/acme/x/contents/%252e%252e/%252e%252e/user?ref=${OID}`,
    "github.com/graphql",
    "evil.example.com/repos/a/b/pulls/1",
  ])("rejects %s", async (path) => {
    const { fetch, call } = setup();
    expect((await call(path)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects requests without the X-Requested-With header", async () => {
    const { fetch, identity } = setup();
    const res = await proxyUserGitHub(new Request(`${origin}${USER_PREFIX}github.com/repos/acme/x/pulls/1`), {
      allowedHosts: ["github.com"],
      identity,
      fetch,
    });
    expect(res.status).toBe(403);
    expect(identity.getSessionUser).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"])("rejects %s", async (method) => {
    const { fetch, call } = setup();
    expect((await call("github.com/repos/acme/x/pulls/1", { method })).status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is not found when sign-in is not configured", async () => {
    const res = await proxyUserGitHub(
      new Request(`${origin}${USER_PREFIX}github.com/repos/a/b/pulls/1`, { headers: XRW }),
      {
        allowedHosts: ["github.com"],
        identity: undefined,
      },
    );
    expect(res.status).toBe(404);
  });

  it("bounds response size", async () => {
    const { call } = setup({ upstream: () => new Response("x".repeat(11 * 1024 * 1024)) });
    const res = await call(`github.com/repos/acme/big/git/blobs/${OID}`);
    expect(res.status).toBe(502);
  });

  it("reads review threads with the fixed GraphQL query and validated variables only", async () => {
    const page = (hasNextPage: boolean, id: string) => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage, endCursor: "c1" },
              nodes: [
                {
                  id,
                  isResolved: true,
                  path: "a.md",
                  resolvedBy: { login: "o" },
                  comments: { nodes: [{ databaseId: 7 }] },
                },
              ],
            },
          },
        },
      },
    });
    const { fetch, call, auth } = setup({
      upstream: (_, init) => Response.json(page(!JSON.parse(String(init?.body)).variables.after, "T")),
    });
    const res = await call("github.com/repos/acme/threads/pulls/12/review-threads");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const threads = (await res.json()) as { nodeId: string; isResolved: boolean }[];
    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({ isResolved: true });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe("https://api.github.com/graphql");
    expect(auth(1)).toBe("Bearer user-token");
    const sent = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    expect(sent.query).toMatch(/reviewThreads/);
    expect(sent.variables).toEqual({ owner: "acme", name: "threads", number: 12, after: null });
  });

  it("logs categories and GitHub request metrics only, never tokens or repositories", async () => {
    const logs = captureLogs();
    await setup({ token: null }).call("github.com/repos/acme/log/pulls/1");
    await setup().call("github.com/repos/acme/logged/pulls/1");
    expect(logs.events()).toContainEqual(
      expect.objectContaining({ event: "github.user_proxy", category: "reauth", status: 401 }),
    );
    expect(logs.events()).toContainEqual(
      expect.objectContaining({ event: "github.request", route: "/repos/:/:/pulls/:", status: 200 }),
    );
    expect(logs.raw()).not.toMatch(/token|acme|logged|octocat/);
  });
});
