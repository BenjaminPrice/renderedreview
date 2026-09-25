// SPDX-License-Identifier: AGPL-3.0-only
// The write boundary against a mocked GitHub: nothing here reaches the network.
import {
  encodeAnnotation,
  type RenderedReviewAnnotationV1,
  repairCommentBody,
} from "@rendered-review/annotation-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntitlementCheck } from "../billing";
import type { ContributorTracker } from "../contributors";
import { captureLogs } from "../test-utils";
import { publishToGitHub, WRITE_PREFIX } from "./publish";

const origin = "https://app.example";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const REPO_ID = 123456;
const user = { id: "u1", login: "octocat", avatarUrl: null };

const annotation = (target: Partial<RenderedReviewAnnotationV1["target"]> = {}): RenderedReviewAnnotationV1 => ({
  version: 1,
  target: {
    githubHost: "github.com",
    repositoryId: REPO_ID,
    repository: "acme/widgets",
    pullRequest: 7,
    path: "docs/a.md",
    commitOid: HEAD,
    blobOid: OTHER,
    selectors: [
      { type: "TextQuoteSelector", exact: "retries" },
      { type: "TextPositionSelector", start: 0, end: 7 },
      { type: "MarkdownSourceRangeSelector", startLine: 3, startColumn: 1, endLine: 3, endColumn: 8 },
    ],
    ...target,
  },
  motivation: "commenting",
});
/** GitHub's exact 403 message when an organization restricts OAuth Apps. */
const ORG_RESTRICTED =
  "Although you appear to have the correct authorization credentials, the `Call-for-Code` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. For more information on these restrictions, including how to enable this app, visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/";

const withMarker = (text: string, a = annotation()) => `${text}\n\n${encodeAnnotation(a)}`;

type Route = (init: RequestInit) => Response | Promise<Response>;
const rawPull = (head = HEAD) => ({
  id: 1,
  number: 7,
  head: { ref: "topic", sha: head, repo: null },
  base: { ref: "main", sha: OTHER, repo: { id: REPO_ID, name: "widgets", owner: { login: "acme", id: 2 } } },
});

let repoCounter = 0;
/** Each test gets its own repository name: the broker caches visibility per repository. */
function setup({
  session = user as typeof user | null,
  appToken = "app-token" as string | null,
  publicToken = null as string | null,
  installed = true,
  visibility = "public" as "public" | "private",
  head = HEAD,
  routes = {} as Record<string, Route>,
  approvalUrl = undefined as string | undefined,
  entitlement = undefined as EntitlementCheck | undefined,
  contributors = undefined as ContributorTracker | undefined,
} = {}) {
  const repo = `widgets-${++repoCounter}`;
  // Its own user too: the per-user publish limit is process-wide.
  const viewer = session && { ...session, id: `user-${repoCounter}` };
  const base = `https://api.github.com/repos/acme/${repo}`;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = String(input);
    const key = `${init.method ?? "GET"} ${url.replace(base, "").replace("https://api.github.com", "")}`;
    if (key === "GET ")
      return Response.json({
        private: visibility === "private",
        visibility,
        owner: { id: 2, login: "acme", type: "Organization" },
      });
    if (key === "GET /pulls/7") return Response.json(rawPull(head));
    const route = routes[key];
    if (!route) throw new Error(`unexpected GitHub request: ${key}`);
    return route(init);
  });
  const identity = {
    getSessionUser: vi.fn(async () => viewer),
    getUserGitHubToken: vi.fn(async () => appToken),
    getUserPublicWriteToken: vi.fn(async () => publicToken),
  };
  const call = (operation: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
    publishToGitHub(
      new Request(`${origin}${WRITE_PREFIX}github.com/acme/${repo}/pulls/7/${operation}`, {
        method,
        headers: {
          "x-requested-with": "rendered-review",
          "content-type": "application/json",
          origin,
          ...headers,
        },
        ...(method === "POST" && {
          body: typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body),
          duplex: "half",
        }),
      } as RequestInit),
      {
        allowedHosts: ["github.com"],
        identity,
        installed: async () => installed,
        fetch,
        approvalUrl,
        entitlement,
        contributors,
      },
    );
  const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === "POST");
  const sent = (i: number) => JSON.parse(writes()[i]![1]!.body as string) as Record<string, unknown>;
  const auth = (i: number) => (writes()[i]![1]!.headers as Record<string, string>).Authorization;
  return { call, fetch, identity, writes, sent, auth };
}

const created =
  (body: object = {}) =>
  () =>
    Response.json({ id: 900, html_url: "https://github.com/x", ...body }, { status: 201 });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const comment = (extra: object = {}) => ({
  expectedHeadOid: HEAD,
  representation: "review-line",
  body: "Please clarify",
  path: "docs/a.md",
  line: 3,
  side: "RIGHT",
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("request guards", () => {
  it("404s when this deployment has no sign-in", async () => {
    const res = await publishToGitHub(
      new Request(`${origin}${WRITE_PREFIX}github.com/a/b/pulls/1/comment`, { method: "POST" }),
      {
        allowedHosts: ["github.com"],
        identity: undefined,
      },
    );
    expect(res.status).toBe(404);
  });

  it("accepts POST only", async () => {
    const { call } = setup();
    expect((await call("comment", undefined, {}, "GET")).status).toBe(405);
  });

  it.each([
    ["X-Requested-With is missing", { "x-requested-with": "" }, 403, "csrf"],
    ["the request comes from another origin", { origin: "https://evil.example" }, 403, "csrf"],
    ["the body is not JSON", { "content-type": "text/plain" }, 415, "unsupported-media-type"],
  ])("refuses the request when %s", async (_, headers, status, code) => {
    const { call, fetch, identity } = setup();
    const res = await call("comment", comment(), headers);
    expect(res.status).toBe(status);
    expect(await json(res)).toMatchObject({ code });
    expect(identity.getSessionUser).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a session: 401 JSON, never cached", async () => {
    const { call, fetch } = setup({ session: null });
    const res = await call("comment", comment());
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ code: "unauthenticated" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("404s an unknown operation and 403s a host outside the allowlist", async () => {
    const { call } = setup();
    expect((await call("delete", comment())).status).toBe(404);
    const res = await publishToGitHub(
      new Request(`${origin}${WRITE_PREFIX}evil.example/a/b/pulls/1/comment`, {
        method: "POST",
        headers: { "x-requested-with": "rendered-review", "content-type": "application/json", origin },
        body: "{}",
      }),
      { allowedHosts: ["github.com"], identity: setup().identity },
    );
    expect(res.status).toBe(403);
  });

  it("stops reading an oversized body instead of buffering all of it", async () => {
    const { call, fetch } = setup();
    // 4 MiB in 64 KiB chunks, with no Content-Length to go by.
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulled > 64) return controller.close();
        controller.enqueue(new Uint8Array(64 * 1024).fill(32));
      },
    });
    const res = await call("comment", body);
    expect(res.status).toBe(413);
    expect(await json(res)).toMatchObject({ code: "request-too-large" });
    expect(pulled).toBeLessThan(32);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a declared oversized body without reading it", async () => {
    const { call } = setup();
    const res = await call("comment", comment(), { "content-length": String(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(await json(res)).toMatchObject({ code: "request-too-large" });
  });

  it("rejects malformed JSON", async () => {
    const { call } = setup();
    const res = await call("comment", "{not json");
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "invalid-request" });
  });
});

describe("credential selection", () => {
  it.each([
    ["the user must link the OAuth App", { installed: false, publicToken: null }, 403, "needs-public-authorization"],
    ["the repository is private", { visibility: "private" as const }, 403, "private-repo-unsupported"],
    ["the GitHub token is gone", { appToken: null }, 401, "reauth"],
    [
      "the owner's plan does not cover the private repository",
      {
        visibility: "private" as const,
        entitlement: async () => ({ allowed: false, reason: "no-entitlement" }) as const,
      },
      403,
      "not-entitled",
    ],
  ])("answers a typed error when %s", async (_, options, status, code) => {
    const { call, writes } = setup(options);
    const res = await call("comment", comment());
    expect(res.status).toBe(status);
    expect(await json(res)).toMatchObject({ code });
    expect(writes()).toHaveLength(0);
  });

  it("publishes to a private repository its owner's plan covers, with the GitHub App user token", async () => {
    const { call, auth } = setup({
      visibility: "private",
      entitlement: async () => ({ allowed: true, reason: "subscription" }),
      routes: { "POST /pulls/7/comments": created() },
    });
    expect((await call("comment", comment())).status).toBe(201);
    expect(auth(0)).toBe("Bearer app-token");
  });

  it("publishes with the OAuth App token on a public repository without the app", async () => {
    const { call, auth } = setup({
      installed: false,
      publicToken: "oauth-token",
      routes: { "POST /pulls/7/comments": created() },
    });
    expect((await call("comment", comment())).status).toBe(201);
    expect(auth(0)).toBe("Bearer oauth-token");
  });
});

describe("comment", () => {
  it("publishes a native line comment on the verified head", async () => {
    const { call, sent, auth } = setup({ routes: { "POST /pulls/7/comments": created({ path: "docs/a.md" }) } });
    const res = await call("comment", comment({ startLine: 1, startSide: "RIGHT" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await json(res)).toMatchObject({ comment: { id: 900, path: "docs/a.md" } });
    expect(auth(0)).toBe("Bearer app-token");
    expect(sent(0)).toEqual({
      body: "Please clarify",
      commit_id: HEAD,
      path: "docs/a.md",
      line: 3,
      side: "RIGHT",
      start_line: 1,
      start_side: "RIGHT",
    });
  });

  it("publishes a file-level comment", async () => {
    const { call, sent } = setup({ routes: { "POST /pulls/7/comments": created() } });
    const res = await call("comment", {
      expectedHeadOid: HEAD,
      representation: "review-file",
      body: "b",
      path: "docs/a.md",
    });
    expect(res.status).toBe(201);
    expect(sent(0)).toMatchObject({ path: "docs/a.md", subject_type: "file" });
  });

  it("publishes a conversation comment, including an application-thread reply with a same-PR annotation", async () => {
    const body = withMarker("Agreed", {
      ...annotation(),
      motivation: "replying",
      replyTo: "issuecomment-1",
      threadId: "t1",
    });
    const { call, sent } = setup({ routes: { "POST /issues/7/comments": created() } });
    const res = await call("comment", { expectedHeadOid: HEAD, representation: "conversation", body });
    expect(res.status).toBe(201);
    expect(sent(0)).toEqual({ body });
  });

  it("publishes a plain top-level conversation comment with no annotation", async () => {
    const { call, sent } = setup({ routes: { "POST /issues/7/comments": created() } });
    const res = await call("comment", { expectedHeadOid: HEAD, representation: "conversation", body: "Looks good" });
    expect(res.status).toBe(201);
    expect(sent(0)).toEqual({ body: "Looks good" });
  });

  it("publishes a plain conversation comment even when the head moved: it isn't tied to a revision", async () => {
    const { call, sent } = setup({ head: OTHER, routes: { "POST /issues/7/comments": created() } });
    const res = await call("comment", { expectedHeadOid: HEAD, representation: "conversation", body: "LGTM" });
    expect(res.status).toBe(201);
    expect(sent(0)).toEqual({ body: "LGTM" });
  });

  it("still refuses an annotated conversation comment when the head moved", async () => {
    const { call, writes } = setup({ head: OTHER });
    const body = withMarker("Agreed", annotation());
    const res = await call("comment", { expectedHeadOid: HEAD, representation: "conversation", body });
    expect(res.status).toBe(409);
    expect(writes()).toHaveLength(0);
  });

  it("still checks the expected head's format on a plain conversation comment", async () => {
    const { call } = setup();
    const res = await call("comment", { expectedHeadOid: "nope", representation: "conversation", body: "b" });
    expect(res.status).toBe(400);
  });

  it("answers 409 stale-head with the current head when the PR moved on", async () => {
    const { call, writes } = setup({ head: OTHER });
    const res = await call("comment", comment());
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "stale-head", headOid: OTHER });
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ["a line comment without a line", comment({ line: undefined }), "invalid-request"],
    ["a line comment without a path", comment({ path: undefined }), "invalid-request"],
    ["a range that ends before it starts", comment({ startLine: 9 }), "invalid-request"],
    ["a conversation comment with a line", comment({ representation: "conversation" }), "invalid-request"],
    ["an unknown representation", comment({ representation: "inline" }), "invalid-request"],
    ["an empty body", comment({ body: "  " }), "invalid-request"],
    ["a malformed head OID", comment({ expectedHeadOid: "main" }), "invalid-request"],
    ["a body over GitHub's limit", comment({ body: "x".repeat(65_537) }), "body-too-large"],
    ["a damaged annotation", comment({ body: "hi <!-- rendered-review:v1:!!! -->" }), "invalid-annotation"],
  ])("rejects %s before calling GitHub", async (_, body, code) => {
    const { call, fetch } = setup();
    const res = await call("comment", body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await json(res)).toMatchObject({ code });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["another repository", { repositoryId: 99 }],
    ["another pull request", { pullRequest: 8 }],
    ["another GitHub host", { githubHost: "ghe.example.com" }],
  ])("rejects an annotation that targets %s", async (_, target) => {
    const { call, writes } = setup();
    const res = await call("comment", comment({ body: withMarker("hi", annotation(target)) }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "annotation-mismatch" });
    expect(writes()).toHaveLength(0);
  });

  it("offers a file comment when GitHub rejects the line", async () => {
    const { call } = setup({
      routes: { "POST /pulls/7/comments": () => Response.json({ message: "Validation Failed" }, { status: 422 }) },
    });
    const res = await call("comment", comment());
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ code: "github-rejected", retryAs: "review-file" });
  });

  it("names an organization's OAuth App restriction instead of forwarding GitHub's message", async () => {
    const logs = captureLogs();
    const { call } = setup({
      publicToken: "oauth-token",
      installed: false,
      routes: { "POST /pulls/7/comments": () => Response.json({ message: ORG_RESTRICTED }, { status: 403 }) },
    });
    const res = await call("comment", comment());
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({
      code: "oauth-org-restricted",
      message: "The Call-for-Code organization restricts third-party apps",
      org: "Call-for-Code",
      approvalUrl: "https://docs.github.com/articles/restricting-access-to-your-organization-s-data/",
    });
    expect(logs.events()).toContainEqual(
      expect.objectContaining({ event: "github.publish", category: "oauth-org-restricted", status: 403 }),
    );
    expect(logs.raw()).not.toContain("Although you appear");
  });

  it("links to the OAuth App's page, where users ask an organization to approve it, when configured", async () => {
    const { call } = setup({
      publicToken: "oauth-token",
      installed: false,
      approvalUrl: "https://github.com/settings/connections/applications/Ov23abc",
      routes: { "POST /issues/7/comments": () => Response.json({ message: ORG_RESTRICTED }, { status: 403 }) },
    });
    const res = await call("comment", { expectedHeadOid: HEAD, representation: "conversation", body: "b" });
    expect(await json(res)).toMatchObject({
      code: "oauth-org-restricted",
      approvalUrl: "https://github.com/settings/connections/applications/Ov23abc",
    });
  });

  it.each([
    ["not a GitHub login", "Call for Code"],
    ["longer than a GitHub login", "a".repeat(40)],
  ])("names no organization when the one in the message is %s", async (_, org) => {
    const { call } = setup({
      publicToken: "oauth-token",
      installed: false,
      routes: {
        "POST /pulls/7/comments": () =>
          Response.json({ message: ORG_RESTRICTED.replace("Call-for-Code", org) }, { status: 403 }),
      },
    });
    const body = await json(await call("comment", comment()));
    expect(body).toMatchObject({
      code: "oauth-org-restricted",
      message: "This organization restricts third-party apps",
    });
    expect(body).not.toHaveProperty("org");
  });

  it("reports GitHub's rate limit with its reset time", async () => {
    const { call } = setup({
      routes: {
        "POST /issues/7/comments": () =>
          Response.json(
            { message: "You have exceeded a secondary rate limit" },
            { status: 403, headers: { "retry-after": "60" } },
          ),
      },
    });
    const res = await call("comment", { expectedHeadOid: HEAD, representation: "conversation", body: "b" });
    expect(res.status).toBe(429);
    expect(await json(res)).toMatchObject({ code: "rate-limited", resetAt: expect.any(String) });
  });

  it("limits how fast one user can publish", async () => {
    const { call } = setup({ routes: { "POST /issues/7/comments": created() } });
    const body = { expectedHeadOid: HEAD, representation: "conversation", body: "b" };
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await call("comment", body)).status);
    expect(statuses.slice(0, 60).every((s) => s === 201)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("counts each draft of a review against the limit", async () => {
    const { call } = setup({ routes: { "POST /issues/7/comments": created() } });
    const drafts = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({ id: `d${from + i}`, representation: "conversation", body: "b" }));
    const review = (submissionId: string, n: number) => ({
      expectedHeadOid: HEAD,
      submissionId,
      event: "COMMENT",
      drafts: drafts(n),
    });
    expect((await call("review", review("s1", 50))).status).toBe(200);
    expect((await call("review", review("s2", 11))).status).toBe(429);
  });

  it("logs outcome categories and GitHub request metrics only, never bodies, tokens or repositories", async () => {
    const logs = captureLogs();
    await setup({ head: OTHER }).call("comment", comment({ body: "secret words" }));
    await setup({ routes: { "POST /pulls/7/comments": created() } }).call(
      "comment",
      comment({ body: withMarker("more secret words") }),
    );
    expect(logs.events()).toContainEqual({
      level: "info",
      event: "github.publish",
      category: "stale-head",
      status: 409,
    });
    expect(logs.events()).toContainEqual({
      level: "info",
      event: "github.publish",
      category: "published",
      status: 201,
    });
    expect(logs.events()).toContainEqual(
      expect.objectContaining({
        event: "github.request",
        method: "POST",
        route: "/repos/:/:/pulls/:/comments",
        status: 201,
      }),
    );
    expect(logs.raw()).not.toMatch(/secret words|app-token|acme|widgets|rendered-review:|docs\/a\.md|octocat/);
  });
});

describe("review", () => {
  const line = {
    id: "d1",
    representation: "review-line",
    body: "On the diff",
    path: "docs/a.md",
    line: 3,
    side: "RIGHT",
  };
  const file = { id: "d2", representation: "review-file", body: "Whole file", path: "docs/b.md" };
  const talk = { id: "d3", representation: "conversation", body: "Unchanged file" };
  const review = (extra: object = {}) => ({
    expectedHeadOid: HEAD,
    submissionId: "s-1",
    event: "COMMENT",
    body: "Summary",
    drafts: [line, file, talk],
    ...extra,
  });
  const routes = (overrides: Record<string, Route> = {}) => ({
    "POST /pulls/7/reviews": () => Response.json({ id: 55, state: "COMMENTED" }),
    "POST /pulls/7/comments": created({ id: 901 }),
    "POST /issues/7/comments": created({ id: 902 }),
    ...overrides,
  });

  it("publishes line drafts and the summary as one native review, the rest by their own representation", async () => {
    const { call, sent, writes } = setup({ routes: routes() });
    const res = await call("review", review());
    expect(res.status).toBe(200);
    expect(writes().map(([url]) => String(url).replace(/.*\/pulls\/7|.*\/issues\/7/, ""))).toEqual([
      "/reviews",
      "/comments",
      "/comments",
    ]);
    expect(sent(0)).toEqual({
      commit_id: HEAD,
      event: "COMMENT",
      body: "Summary",
      comments: [{ path: "docs/a.md", body: "On the diff", line: 3, side: "RIGHT" }],
    });
    expect(sent(1)).toEqual({ body: "Whole file", commit_id: HEAD, path: "docs/b.md", subject_type: "file" });
    expect(sent(2)).toEqual({ body: "Unchanged file" });
    expect(await json(res)).toEqual({
      ok: true,
      review: { ok: true, reviewId: 55 },
      results: [
        { draftId: "d1", ok: true, reviewId: 55 },
        { draftId: "d2", ok: true, commentId: 901, url: "https://github.com/x" },
        { draftId: "d3", ok: true, commentId: 902, url: "https://github.com/x" },
      ],
    });
  });

  it("submits an approval with no comments", async () => {
    const { call, sent } = setup({ routes: routes() });
    const res = await call("review", review({ event: "APPROVE", body: undefined, drafts: [] }));
    expect(res.status).toBe(200);
    expect(sent(0)).toEqual({ commit_id: HEAD, event: "APPROVE", comments: [] });
  });

  it("skips the native review when there is nothing to put in it", async () => {
    const { call, writes } = setup({ routes: routes() });
    const body = await json(await call("review", review({ body: undefined, drafts: [talk] })));
    expect(body).toMatchObject({ ok: true, results: [{ draftId: "d3", ok: true }] });
    expect(body).not.toHaveProperty("review");
    expect(writes()).toHaveLength(1);
  });

  it("reports every draft's outcome when some fail, dropping none", async () => {
    const { call } = setup({
      routes: routes({
        "POST /pulls/7/reviews": () => Response.json({ message: "Validation Failed" }, { status: 422 }),
        "POST /issues/7/comments": () => Response.json({ message: "boom" }, { status: 500 }),
      }),
    });
    const body = await json(await call("review", review()));
    expect(body).toMatchObject({
      ok: false,
      review: { ok: false, error: { code: "github-rejected" } },
      results: [
        { draftId: "d1", ok: false, error: { code: "github-rejected", retryAs: "review-file" } },
        { draftId: "d2", ok: true, commentId: 901 },
        { draftId: "d3", ok: false, error: { code: "github-error" } },
      ],
    });
  });

  it("publishes a submission once, even when it is sent twice", async () => {
    const { call, writes } = setup({ routes: routes() });
    const [a, b] = await Promise.all([call("review", review()), call("review", review())]);
    const again = await call("review", review());
    const bodies = await Promise.all([a, b, again].map(json));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(writes()).toHaveLength(3);
  });

  it("lets a submission refused before publishing be sent again", async () => {
    const stale = setup({ head: OTHER, routes: routes() });
    expect((await stale.call("review", review({ submissionId: "s-stale" }))).status).toBe(409);
    expect((await stale.call("review", review({ submissionId: "s-stale" }))).status).toBe(409);
    expect(stale.writes()).toHaveLength(0);
  });

  it.each([
    ["no submission id", review({ submissionId: undefined })],
    ["an unknown event", review({ event: "MERGE" })],
    ["duplicate draft ids", review({ drafts: [line, line] })],
    ["a draft without an id", review({ drafts: [{ ...talk, id: undefined }] })],
    ["too many drafts", review({ drafts: Array.from({ length: 51 }, (_, i) => ({ ...talk, id: `d${i}` })) })],
    ["a line draft without a line", review({ drafts: [{ ...line, line: undefined }] })],
  ])("rejects a submission with %s before calling GitHub", async (_, body) => {
    const { call, fetch } = setup({ routes: routes() });
    const res = await call("review", body);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "invalid-request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names the draft whose annotation targets another pull request, publishing nothing", async () => {
    const { call, writes } = setup({ routes: routes() });
    const res = await call(
      "review",
      review({ drafts: [line, { ...talk, body: withMarker("x", annotation({ pullRequest: 8 })) }] }),
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "annotation-mismatch", draftId: "d3" });
    expect(writes()).toHaveLength(0);
  });
});

describe("reply", () => {
  it("replies in a native review thread", async () => {
    const { call, sent, writes } = setup({ routes: { "POST /pulls/7/comments/4034118605/replies": created() } });
    const res = await call("reply", { expectedHeadOid: HEAD, inReplyTo: 4034118605, body: "Done" });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ comment: { id: 900 } });
    expect(String(writes()[0]![0])).toMatch(/\/pulls\/7\/comments\/4034118605\/replies$/);
    expect(sent(0)).toEqual({ body: "Done" });
  });

  it.each([
    ["no comment id", { expectedHeadOid: HEAD, body: "Done" }, "invalid-request"],
    [
      "a comment id that is not a number",
      { expectedHeadOid: HEAD, inReplyTo: "1/../../x", body: "Done" },
      "invalid-request",
    ],
    [
      "an annotation for another PR",
      { expectedHeadOid: HEAD, inReplyTo: 1, body: withMarker("x", annotation({ pullRequest: 9 })) },
      "annotation-mismatch",
    ],
  ])("refuses a reply with %s", async (_, body, code) => {
    const { call, writes } = setup();
    const res = await call("reply", body);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code });
    expect(writes()).toHaveLength(0);
  });
});

describe("resolve", () => {
  const graphql = (threadPr: { repositoryId: number; number: number } | null) => {
    const queries: { query: string; variables: unknown }[] = [];
    const route: Route = (init) => {
      const { query, variables } = JSON.parse(init.body as string) as { query: string; variables: unknown };
      queries.push({ query, variables });
      if (query.startsWith("query"))
        return Response.json({
          data: {
            node: threadPr && {
              pullRequest: { number: threadPr.number, repository: { databaseId: threadPr.repositoryId } },
            },
          },
        });
      const mutation = /(\w+)\(input/.exec(query)![1]!;
      return Response.json({
        data: { [mutation]: { thread: { id: "PRRT_1", isResolved: mutation === "resolveReviewThread" } } },
      });
    };
    return { queries, routes: { "POST /graphql": route } };
  };

  it.each([
    [true, "resolveReviewThread"],
    [false, "unresolveReviewThread"],
  ])("sets a native thread's resolution (resolved: %s)", async (resolved, mutation) => {
    const { queries, routes } = graphql({ repositoryId: REPO_ID, number: 7 });
    const { call } = setup({ routes });
    const res = await call("resolve", { threadNodeId: "PRRT_1", resolved });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ thread: { nodeId: "PRRT_1", isResolved: resolved } });
    expect(queries.map((q) => q.variables)).toEqual([{ id: "PRRT_1" }, { id: "PRRT_1" }]);
    expect(queries[1]!.query).toMatch(new RegExp(`^mutation\\(\\$id: ID!\\) \\{ ${mutation}\\(`));
  });

  it("names an organization's OAuth App restriction reported as a GraphQL FORBIDDEN error", async () => {
    const { routes } = graphql({ repositoryId: REPO_ID, number: 7 });
    const threadQuery = routes["POST /graphql"];
    const { call } = setup({
      publicToken: "oauth-token",
      installed: false,
      routes: {
        "POST /graphql": (init) =>
          (init.body as string).includes("mutation")
            ? Response.json({ data: null, errors: [{ type: "FORBIDDEN", message: ORG_RESTRICTED }] })
            : threadQuery(init),
      },
    });
    const res = await call("resolve", { threadNodeId: "PRRT_1", resolved: true });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "oauth-org-restricted", org: "Call-for-Code" });
  });

  it("refuses a thread from another pull request", async () => {
    const { queries, routes } = graphql({ repositoryId: 999, number: 7 });
    const { call } = setup({ routes });
    const res = await call("resolve", { threadNodeId: "PRRT_1", resolved: true });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "thread-mismatch" });
    expect(queries).toHaveLength(1);
  });

  it.each([
    ["a malformed thread id", { threadNodeId: "x y", resolved: true }],
    ["no resolution", { threadNodeId: "PRRT_1" }],
  ])("refuses %s before calling GitHub", async (_, body) => {
    const { call, fetch } = setup();
    const res = await call("resolve", body);
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("edit", () => {
  const OLD = withMarker("> old quote\n\nPlease clarify", annotation({ commitOid: OTHER }));
  const repaired = (location: "conversation" | "review-line", a = annotation(), body = OLD) =>
    repairCommentBody({ body, annotation: a, location }).body;
  const NEW = repaired("conversation");
  const NEW_REVIEW = repaired("review-line");
  const author = { login: "octocat", id: 583231, node_id: "U_1", type: "User" };
  const stranger = { ...author, login: "mallory", id: 666 };
  const rawComment = (extra: object = {}) => ({
    id: 5,
    node_id: "IC_5",
    body: OLD,
    user: author,
    author_association: "MEMBER",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/acme/widgets/pull/7#issuecomment-5",
    issue_url: "https://api.github.com/repos/acme/widgets/issues/7",
    ...extra,
  });
  const edit = (extra: object = {}) => ({
    expectedHeadOid: HEAD,
    commentType: "issue",
    commentId: 5,
    previousBody: OLD,
    body: NEW,
    ...extra,
  });
  const routes = (comment: object = rawComment(), me: object = author) => ({
    "GET /user": () => Response.json(me),
    "GET /issues/comments/5": () => Response.json(comment),
    "PATCH /issues/comments/5": (init: RequestInit) =>
      Response.json({ ...comment, body: JSON.parse(init.body as string).body }),
  });
  const patches = (fetch: ReturnType<typeof setup>["fetch"]) =>
    fetch.mock.calls.filter(([, init]) => init?.method === "PATCH");

  it("does not count repairing an anchor as contributor activity", async () => {
    // A repair only moves an existing comment; the pricing metric's qualifying actions don't include it.
    const contributors = vi.fn<ContributorTracker>(async () => {});
    const entitlement = async () => ({ allowed: true, reason: "subscription" }) as const;
    const { call } = setup({ routes: routes(), visibility: "private", entitlement, contributors });
    expect((await call("edit", edit())).status).toBe(200);
    expect(contributors).not.toHaveBeenCalled();
  });

  it("replaces the signed-in author's conversation comment body", async () => {
    const { call, fetch } = setup({ routes: routes() });
    const res = await call("edit", edit());
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ comment: { id: 5, body: NEW } });
    const sent = patches(fetch);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]![0])).toMatch(/\/issues\/comments\/5$/);
    expect(JSON.parse(sent[0]![1]!.body as string)).toEqual({ body: NEW });
    expect((sent[0]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer app-token");
  });

  // A review comment on head lines 2–4 of docs/a.md; the annotation selects line 3.
  const rawReview = (extra: object = {}) => ({
    ...rawComment({ issue_url: undefined }),
    path: "docs/a.md",
    line: 4,
    start_line: 2,
    side: "RIGHT",
    start_side: "RIGHT",
    pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/7",
    ...extra,
  });
  const reviewRoutes = (review: object = rawReview()) => ({
    "GET /user": () => Response.json(author),
    "GET /pulls/comments/5": () => Response.json(review),
    "PATCH /pulls/comments/5": () => Response.json({ ...review, body: NEW_REVIEW }),
  });

  it("replaces the signed-in author's review comment body", async () => {
    const { call, fetch } = setup({ routes: reviewRoutes() });
    const res = await call("edit", edit({ commentType: "review", body: NEW_REVIEW }));
    expect(res.status).toBe(200);
    expect(JSON.parse(patches(fetch)[0]![1]!.body as string)).toEqual({ body: NEW_REVIEW });
  });

  it("refuses a body that isn't the repair of the previous one, before calling GitHub", async () => {
    // The same valid marker, but the reviewer's text changed.
    const { call, fetch } = setup({ routes: routes() });
    const res = await call("edit", edit({ body: NEW.replace("Please clarify", "Please approve") }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "invalid-repair" });
    expect(patches(fetch)).toHaveLength(0);
    // Written for the other kind of comment: a permalink added or dropped.
    const other = await call("edit", edit({ body: NEW_REVIEW }));
    expect(await json(other)).toMatchObject({ code: "invalid-repair" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["GitHub lines the new selection doesn't overlap", rawReview({ line: 12, start_line: 10 })],
    ["an outdated comment, which has no current lines", rawReview({ line: null, start_line: null })],
    ["a comment on base lines", rawReview({ side: "LEFT", start_side: "LEFT" })],
  ])("refuses a review comment repair onto %s", async (_, review) => {
    const { call, fetch } = setup({ routes: reviewRoutes(review) });
    const res = await call("edit", edit({ commentType: "review", body: NEW_REVIEW }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "invalid-repair" });
    expect(patches(fetch)).toHaveLength(0);
  });

  it("refuses to edit someone else's comment, by GitHub user id, without editing it", async () => {
    // Same login, different account: only the id counts.
    const { call, fetch } = setup({ routes: routes(rawComment({ user: { ...stranger, login: "octocat" } })) });
    const res = await call("edit", edit());
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "not-author" });
    expect(patches(fetch)).toHaveLength(0);
  });

  it("answers 409 stale-head when the PR moved on, without editing", async () => {
    const { call, fetch } = setup({ head: OTHER, routes: routes() });
    const res = await call("edit", edit());
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "stale-head", headOid: OTHER });
    expect(patches(fetch)).toHaveLength(0);
  });

  it("refuses when the comment changed on GitHub since the preview", async () => {
    const { call, fetch } = setup({ routes: routes(rawComment({ body: `${OLD}\n\nEdited on GitHub` })) });
    const res = await call("edit", edit());
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "comment-changed" });
    expect(patches(fetch)).toHaveLength(0);
  });

  it("answers a repeated edit that already landed without editing again", async () => {
    const { call, fetch } = setup({ routes: routes(rawComment({ body: NEW })) });
    const res = await call("edit", edit());
    expect(res.status).toBe(200);
    expect(patches(fetch)).toHaveLength(0);
  });

  it("refuses a comment from another pull request", async () => {
    const { call, fetch } = setup({
      routes: routes(rawComment({ issue_url: "https://api.github.com/repos/acme/widgets/issues/8" })),
    });
    const res = await call("edit", edit());
    expect(res.status).toBe(404);
    expect(patches(fetch)).toHaveLength(0);
  });

  it("refuses a review comment whose file isn't the annotation's", async () => {
    const { call, fetch } = setup({ routes: reviewRoutes(rawReview({ path: "docs/b.md" })) });
    const res = await call("edit", edit({ commentType: "review", body: NEW_REVIEW }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "annotation-mismatch" });
    expect(patches(fetch)).toHaveLength(0);
  });

  it.each([
    ["a body without an annotation", edit({ body: "Please clarify" }), "invalid-annotation"],
    [
      "an annotation for another PR",
      edit({ body: repaired("conversation", annotation({ pullRequest: 9 })) }),
      "annotation-mismatch",
    ],
    ["an unknown comment type", edit({ commentType: "commit" }), "invalid-request"],
    ["a comment id that is not a number", edit({ commentId: "5/../x" }), "invalid-request"],
    ["no previous body", edit({ previousBody: undefined }), "invalid-request"],
  ])("refuses %s", async (_, body, code) => {
    const { call, fetch } = setup({ routes: routes() });
    const res = await call("edit", body);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code });
    expect(patches(fetch)).toHaveLength(0);
  });
});

describe("active private contributor counting", () => {
  const allowed = async () => ({ allowed: true, reason: "subscription" }) as const;
  /** A private repository its owner's plan covers, with a contributor tracker spy. */
  function counting(routes: Record<string, Route>, options: Parameters<typeof setup>[0] = {}) {
    const contributors = vi.fn<ContributorTracker>(async () => {});
    const s = setup({ visibility: "private", entitlement: allowed, contributors, routes, ...options });
    const countedFor = async () => {
      const viewer = await s.identity.getSessionUser();
      expect(contributors).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ host: "github.com", owner: "acme", ownerId: "2", ownerType: "Organization" }),
        viewer!.id,
      );
    };
    return { ...s, contributors, countedFor };
  }
  const threadRoutes = {
    "POST /graphql": (init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      if (query.startsWith("query"))
        return Response.json({
          data: { node: { pullRequest: { number: 7, repository: { databaseId: REPO_ID } } } },
        });
      const mutation = /(\w+)\(input/.exec(query)![1]!;
      return Response.json({ data: { [mutation]: { thread: { id: "PRRT_1", isResolved: true } } } });
    },
  };
  const talk = { id: "d1", representation: "conversation", body: "Unchanged file" };
  const review = (extra: object = {}) => ({
    expectedHeadOid: HEAD,
    submissionId: "s-1",
    event: "COMMENT",
    drafts: [talk],
    ...extra,
  });

  it.each([
    ["publishing a comment", "comment", comment(), { "POST /pulls/7/comments": created() }],
    [
      "creating a suggestion",
      "comment",
      comment({ body: "```suggestion\nretry three times\n```" }),
      { "POST /pulls/7/comments": created() },
    ],
    [
      "publishing a conversation comment",
      "comment",
      { expectedHeadOid: HEAD, representation: "conversation", body: "Looks good" },
      { "POST /issues/7/comments": created() },
    ],
    [
      "replying",
      "reply",
      { expectedHeadOid: HEAD, inReplyTo: 1, body: "Done" },
      { "POST /pulls/7/comments/1/replies": created() },
    ],
    ["submitting a review", "review", review(), { "POST /issues/7/comments": created() }],
    [
      "approving without comments",
      "review",
      review({ event: "APPROVE", drafts: [] }),
      { "POST /pulls/7/reviews": () => Response.json({ id: 55, state: "APPROVED" }) },
    ],
    ["resolving a thread", "resolve", { threadNodeId: "PRRT_1", resolved: true }, threadRoutes],
    ["reopening a thread", "resolve", { threadNodeId: "PRRT_1", resolved: false }, threadRoutes],
  ])("counts the publisher after %s lands on GitHub", async (_, operation, body, routes) => {
    const { call, countedFor } = counting(routes);
    expect((await call(operation, body)).status).toBeLessThan(300);
    await countedFor();
  });

  it("counts a review in which only some drafts landed", async () => {
    const { call, countedFor } = counting({
      "POST /issues/7/comments": created(),
      "POST /pulls/7/comments": () => Response.json({ message: "path not in diff" }, { status: 422 }),
    });
    const file = { id: "d2", representation: "review-file", body: "Whole file", path: "docs/b.md" };
    expect(await json(await call("review", review({ drafts: [talk, file] })))).toMatchObject({ ok: false });
    await countedFor();
  });

  it("does not count a review of which nothing landed", async () => {
    const { call, contributors } = counting({
      "POST /issues/7/comments": () => Response.json({ message: "locked" }, { status: 403 }),
    });
    expect(await json(await call("review", review()))).toMatchObject({ ok: false });
    expect(contributors).not.toHaveBeenCalled();
  });

  it.each([
    [
      "GitHub rejects the write",
      comment(),
      {},
      { "POST /pulls/7/comments": () => new Response("{}", { status: 422 }) },
    ],
    ["the head moved (nothing is written)", comment({ expectedHeadOid: OTHER }), {}, {}],
    ["the body is invalid (nothing is written)", comment({ body: "" }), {}, {}],
    [
      "the owner's plan does not cover the repository",
      comment(),
      { entitlement: async () => ({ allowed: false, reason: "entitlement-expired" }) as const },
      {},
    ],
    ["the repository is public", comment(), { visibility: "public" as const }, { "POST /pulls/7/comments": created() }],
  ])("does not count when %s", async (_, body, options, routes) => {
    const { call, contributors } = counting(routes, options);
    await call("comment", body);
    expect(contributors).not.toHaveBeenCalled();
  });
});
