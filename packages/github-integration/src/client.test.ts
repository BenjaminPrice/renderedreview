// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures are trimmed recordings of public GitHub API responses for mdn/content#45752.
import { describe, expect, it, vi } from "vitest";
import {
  type CacheEntry,
  type GitHubClientOptions,
  type RequestMetric,
  ForbiddenError,
  GitHubError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  createGitHubClient,
} from "./index";
import blobRaw from "./fixtures/blob-raw.json";
import files from "./fixtures/files.json";
import issueComments from "./fixtures/issue-comments.json";
import pull from "./fixtures/pull.json";
import pullCommits from "./fixtures/pull-commits.json";
import reviewComments from "./fixtures/review-comments.json";
import reviewThreads from "./fixtures/review-threads.json";
import reviews from "./fixtures/reviews.json";
import tree from "./fixtures/tree.json";

const API = "https://api.github.com/repos/mdn/content";
const HEAD = "b7ab9298e577bf13d7e973091efc726ba8466d30";
const rateHeaders = {
  "x-ratelimit-limit": "60",
  "x-ratelimit-remaining": "59",
  "x-ratelimit-used": "1",
  "x-ratelimit-reset": "1790225054",
  "x-ratelimit-resource": "core",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...rateHeaders, ...headers },
  });

/** A fetch double answering from a queue of responses and recording each request. */
function setup(responses: (Response | Error)[], options: GitHubClientOptions = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  });
  const metrics: RequestMetric[] = [];
  const client = createGitHubClient({
    fetch: fetch,
    onMetric: (m) => metrics.push(m),
    retryDelayMs: 0,
    ...options,
  });
  const request = (i: number) => ({
    url: String(fetch.mock.calls[i]![0]),
    headers: fetch.mock.calls[i]![1]!.headers as Record<string, string>,
    init: fetch.mock.calls[i]![1]!,
  });
  return { client, fetch, metrics, request };
}

describe("read operations", () => {
  it("fetches and normalizes PR metadata anonymously", async () => {
    const { client, request } = setup([json(pull)]);
    const pr = await client.getPullRequest("mdn", "content", 45752);
    expect(request(0).url).toBe(`${API}/pulls/45752`);
    expect(request(0).headers).toEqual({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
    expect(pr).toMatchObject({
      id: 4555629351,
      nodeId: "PR_kwDOEaEoos8AAAABD4ljJw",
      number: 45752,
      merged: true,
      author: { login: "Josh-Cena", type: "User" },
      authorAssociation: "MEMBER",
      mergedAt: "2026-09-22T00:07:45Z",
      commits: 4,
      labels: [
        "Content:CSS",
        "Content:HTML",
        "Content:WebExt",
        "Content:WebAPI",
        "Content:JS",
        "Content:Learn",
        "Content:Media",
        "Content:Security",
        "size/m",
      ],
      head: { sha: HEAD },
      base: { sha: "76c2e04d720aa8260ba7d75788ed96776aac35c6", repository: { fullName: "mdn/content" } },
    });
    expect(client.rateLimit).toMatchObject({ limit: 60, remaining: 59, resource: "core" });
  });

  it("follows Link pagination for changed files", async () => {
    const next = `${API}/pulls/45752/files?per_page=100&page=2`;
    const { client, request } = setup([
      json(files.slice(0, 2), 200, { link: `<${next}>; rel="next", <${next}>; rel="last"` }),
      json(files.slice(2)),
    ]);
    const result = await client.listPullRequestFiles("mdn", "content", 45752);
    expect(request(0).url).toBe(`${API}/pulls/45752/files?per_page=100`);
    expect(request(1).url).toBe(next);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      path: "files/en-us/learn_web_development/core/structuring_content/html_table_basics/index.md",
      blobOid: "1187b70ba329d86b04fc573682abd31bf6c7ae87",
      status: "modified",
      patch: expect.stringMatching(/^@@ -746,7/),
    });
  });

  it("lists a pull request's commits, oldest first", async () => {
    // Recorded from mdn/content#45377.
    const { client, request } = setup([json(pullCommits)]);
    const commits = await client.listPullRequestCommits("mdn", "content", 45377);
    expect(request(0).url).toBe(`${API}/pulls/45377/commits?per_page=100`);
    expect(commits).toHaveLength(4);
    expect(commits[1]).toEqual({
      oid: "c5ebc9f3071d5e5e143298f508c2aedb7060c884",
      title: "add more info about 102 status",
      committedAt: "2026-09-01T04:55:55Z",
      htmlUrl: "https://github.com/mdn/content/commit/c5ebc9f3071d5e5e143298f508c2aedb7060c884",
    });
  });

  it("reads trees, raw blobs and raw file contents at a commit", async () => {
    const { client, request } = setup([json(tree), json(blobRaw), json(blobRaw)]);
    const t = await client.getTree("mdn", "content", "d4cfcbadcb368b109d7b0e04e72a3a64df10ab14", { recursive: true });
    expect(request(0).url).toBe(`${API}/git/trees/d4cfcbadcb368b109d7b0e04e72a3a64df10ab14?recursive=1`);
    expect(t.truncated).toBe(false);
    expect(t.entries[0]).toEqual({
      path: ".editorconfig",
      mode: "100644",
      type: "blob",
      oid: "afc63ba199812277a9cb2c2f8708ddd30c38c168",
      size: 270,
    });

    const blob = await client.getBlob("mdn", "content", "3cecec5153c1ae6d42bbfabd10d5105c0b868894");
    expect(request(1).headers.Accept).toBe("application/vnd.github.raw+json");
    expect(blob).toBe(blobRaw);
    expect(blob.startsWith('---\ntitle: "CustomElementRegistry: upgrade() method"')).toBe(true);

    await client.getFileContents("mdn", "content", "files/en-us/web/api/a b/index.md", HEAD);
    expect(request(2).url).toBe(`${API}/contents/files/en-us/web/api/a%20b/index.md?ref=${HEAD}`);
  });

  it("normalizes review comments, reviews and issue comments", async () => {
    const { client } = setup([json(reviewComments), json(reviews), json(issueComments)]);
    const comments = await client.listReviewComments("mdn", "content", 45752);
    expect(comments[1]).toMatchObject({
      id: 4038414070,
      inReplyToId: 4034118605,
      path: "files/en-us/web/security/authentication/passkeys/index.md",
      line: null,
      originalLine: 85,
      startLine: null,
      side: "RIGHT",
      subjectType: "line",
      commitOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      originalCommitOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      diffHunk: expect.stringMatching(/^@@/),
    });
    expect(comments[0]!.inReplyToId).toBeNull();

    const [review] = await client.listReviews("mdn", "content", 45752);
    expect(review).toMatchObject({
      state: expect.any(String),
      submittedAt: expect.any(String),
      author: { type: "User" },
    });

    const [bot] = await client.listIssueComments("mdn", "content", 45752);
    expect(bot!.author).toMatchObject({ login: "github-actions[bot]", type: "Bot" });
    expect(bot!.authorAssociation).toBe("CONTRIBUTOR");
  });

  it("reads review-thread resolution over GraphQL with auth", async () => {
    const { client, request } = setup([json(reviewThreads)], { auth: () => "Bearer t0ken" });
    const threads = await client.listReviewThreads("mdn", "content", 45752);
    expect(request(0).url).toBe("https://api.github.com/graphql");
    expect(request(0).init.method).toBe("POST");
    expect(request(0).headers.Authorization).toBe("Bearer t0ken");
    expect(JSON.parse(request(0).init.body as string).variables).toEqual({
      owner: "mdn",
      name: "content",
      number: 45752,
      after: null,
    });
    expect(threads.map((t) => [t.isResolved, t.resolvedBy, t.commentIds])).toEqual([
      [false, null, [4034118605, 4038414070]],
      [true, "Josh-Cena", [4038891173]],
      [true, "Josh-Cena", [4038892679]],
    ]);
  });

  it("uses GHES REST and GraphQL endpoints for other hosts", async () => {
    const { client, request } = setup([json(pull), json(reviewThreads)], { host: "ghe.example.com" });
    await client.getPullRequest("mdn", "content", 1);
    await client.listReviewThreads("mdn", "content", 1);
    expect(request(0).url).toBe("https://ghe.example.com/api/v3/repos/mdn/content/pulls/1");
    expect(request(1).url).toBe("https://ghe.example.com/api/graphql");
  });
});

describe("conditional requests", () => {
  it("revalidates with the cached ETag and reuses the body on 304", async () => {
    const cache = new Map<string, CacheEntry>();
    const { client, request, metrics } = setup([json(pull, 200, { etag: 'W/"abc"' }), json(null, 304)], { cache });
    const first = await client.getPullRequest("mdn", "content", 45752);
    const second = await client.getPullRequest("mdn", "content", 45752);
    expect(request(0).headers["If-None-Match"]).toBeUndefined();
    expect(request(1).headers["If-None-Match"]).toBe('W/"abc"');
    expect(second).toEqual(first);
    expect(metrics.map((m) => m.outcome)).toEqual(["ok", "not-modified"]);
  });

  it("keeps anonymous and authenticated cache entries apart", async () => {
    const cache = new Map<string, CacheEntry>();
    const anon = setup([json(pull, 200, { etag: '"a"' })], { cache });
    await anon.client.getPullRequest("mdn", "content", 45752);
    const authed = setup([json(pull, 200, { etag: '"b"' })], { cache, auth: async () => "Bearer secret" });
    await authed.client.getPullRequest("mdn", "content", 45752);
    expect(authed.request(0).headers["If-None-Match"]).toBeUndefined();
    const keys = [...cache.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.join()).not.toContain("secret");
  });

  it("serves cached pages of a paginated list", async () => {
    const cache = new Map<string, CacheEntry>();
    const next = `${API}/pulls/45752/files?per_page=100&page=2`;
    const { client, fetch } = setup(
      [
        json(files.slice(0, 2), 200, { etag: '"p1"', link: `<${next}>; rel="next"` }),
        json(files.slice(2), 200, { etag: '"p2"' }),
        json(null, 304),
        json(null, 304),
      ],
      { cache },
    );
    await client.listPullRequestFiles("mdn", "content", 45752);
    expect(await client.listPullRequestFiles("mdn", "content", 45752)).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("stale responses on rate limit", () => {
  const limited = () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" });

  it("answers from the cache when rate-limited, if asked to, and reports it as stale", async () => {
    const cache = new Map<string, CacheEntry>();
    const { client, metrics } = setup([json(pull, 200, { etag: '"a"' }), limited()], {
      cache,
      staleOnRateLimit: true,
    });
    const fresh = await client.getPullRequest("mdn", "content", 45752);
    expect(await client.getPullRequest("mdn", "content", 45752)).toEqual(fresh);
    expect(metrics.map((m) => m.outcome)).toEqual(["ok", "stale"]);
    expect(metrics[1]!.rateLimit?.resetAt).toEqual(new Date(1790225054 * 1000));
  });

  it("still throws without a cached entry, or by default", async () => {
    const cache = new Map<string, CacheEntry>();
    const cold = setup([limited()], { cache, staleOnRateLimit: true });
    await expect(cold.client.getPullRequest("mdn", "content", 45752)).rejects.toBeInstanceOf(RateLimitError);
    const byDefault = setup([json(pull, 200, { etag: '"a"' }), limited()], { cache });
    await byDefault.client.getPullRequest("mdn", "content", 45752);
    await expect(byDefault.client.getPullRequest("mdn", "content", 45752)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("errors and retries", () => {
  it("surfaces primary rate-limit exhaustion as RateLimitError without retrying", async () => {
    const { client, fetch } = setup([
      json({ message: "API rate limit exceeded for 203.0.113.1." }, 403, {
        "x-ratelimit-remaining": "0",
        "x-github-request-id": "ED37:1",
      }),
    ]);
    const error = await client.getPullRequest("mdn", "content", 45752).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt).toEqual(new Date(1790225054 * 1000));
    expect((error as RateLimitError).requestId).toBe("ED37:1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses Retry-After for secondary rate limits", async () => {
    const { client } = setup([
      json({ message: "You have exceeded a secondary rate limit." }, 429, { "retry-after": "30" }),
    ]);
    const error = await client.getPullRequest("mdn", "content", 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
  });

  it("maps 404 and 403 to typed errors", async () => {
    const { client } = setup([json({ message: "Not Found" }, 404), json({ message: "Resource not accessible" }, 403)]);
    await expect(client.getPullRequest("mdn", "content", 1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.getPullRequest("mdn", "content", 1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("retries 5xx with backoff and reports each attempt", async () => {
    const { client, metrics } = setup([json({ message: "Bad gateway" }, 502), json(pull)]);
    await expect(client.getPullRequest("mdn", "content", 45752)).resolves.toMatchObject({ number: 45752 });
    expect(metrics.map((m) => [m.status, m.attempt, m.outcome])).toEqual([
      [502, 0, "retry"],
      [200, 1, "ok"],
    ]);
    expect(metrics[1]!.rateLimit?.remaining).toBe(59);
  });

  it("gives up on network errors after maxRetries", async () => {
    const { client, fetch } = setup([new TypeError("offline"), new TypeError("offline"), new TypeError("offline")]);
    const error = await client.getPullRequest("mdn", "content", 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).cause).toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    const { client, fetch } = setup([json({ message: "Validation Failed" }, 422)]);
    await expect(client.getPullRequest("mdn", "content", 1)).rejects.toBeInstanceOf(GitHubError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat an anonymous GraphQL 403 with a zero limit as a rate limit", async () => {
    const { client } = setup([
      json({ message: "Forbidden" }, 403, {
        "x-ratelimit-limit": "0",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-resource": "graphql",
      }),
    ]);
    await expect(client.listReviewThreads("mdn", "content", 1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("maps GraphQL errors", async () => {
    const { client } = setup([
      json({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
      json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }),
    ]);
    await expect(client.listReviewThreads("mdn", "content", 1)).rejects.toBeInstanceOf(RateLimitError);
    await expect(client.listReviewThreads("mdn", "content", 1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("write operations", () => {
  const PR = `${API}/pulls/45752`;
  const sent = (init: RequestInit) => JSON.parse(init.body as string) as Record<string, unknown>;

  it("creates a multi-line review comment on the diff", async () => {
    const { client, request } = setup([json(reviewComments[0], 201)], { auth: () => "Bearer t" });
    const comment = await client.createReviewComment("mdn", "content", 45752, {
      body: "Nice",
      commitId: HEAD,
      path: "files/en-us/a.md",
      line: 12,
      side: "RIGHT",
      startLine: 10,
      startSide: "RIGHT",
    });
    expect(request(0).url).toBe(`${PR}/comments`);
    expect(request(0).init.method).toBe("POST");
    expect(request(0).headers).toMatchObject({ Authorization: "Bearer t", "Content-Type": "application/json" });
    expect(sent(request(0).init)).toEqual({
      body: "Nice",
      commit_id: HEAD,
      path: "files/en-us/a.md",
      line: 12,
      side: "RIGHT",
      start_line: 10,
      start_side: "RIGHT",
    });
    expect(comment.id).toBe(reviewComments[0]!.id);
  });

  it("creates a file-level review comment", async () => {
    const { client, request } = setup([json(reviewComments[0], 201)]);
    await client.createReviewComment("mdn", "content", 45752, { body: "b", commitId: HEAD, path: "a.md" });
    expect(sent(request(0).init)).toEqual({ body: "b", commit_id: HEAD, path: "a.md", subject_type: "file" });
  });

  it("replies to a review thread", async () => {
    const { client, request } = setup([json(reviewComments[1], 201)]);
    await client.replyToReviewComment("mdn", "content", 45752, 4034118605, "Agreed");
    expect(request(0).url).toBe(`${PR}/comments/4034118605/replies`);
    expect(sent(request(0).init)).toEqual({ body: "Agreed" });
  });

  it("submits a review with line comments", async () => {
    const { client, request } = setup([json(reviews[0])]);
    const review = await client.createReview("mdn", "content", 45752, {
      commitId: HEAD,
      event: "REQUEST_CHANGES",
      body: "Summary",
      comments: [{ path: "a.md", body: "x", line: 3, side: "RIGHT" }],
    });
    expect(request(0).url).toBe(`${PR}/reviews`);
    expect(sent(request(0).init)).toEqual({
      commit_id: HEAD,
      event: "REQUEST_CHANGES",
      body: "Summary",
      comments: [{ path: "a.md", body: "x", line: 3, side: "RIGHT" }],
    });
    expect(review.id).toBe(reviews[0]!.id);
  });

  it("creates a PR conversation comment", async () => {
    const { client, request } = setup([json(issueComments[0], 201)]);
    const comment = await client.createIssueComment("mdn", "content", 45752, "Hello");
    expect(request(0).url).toBe(`${API}/issues/45752/comments`);
    expect(sent(request(0).init)).toEqual({ body: "Hello" });
    expect(comment.id).toBe(issueComments[0]!.id);
  });

  it("never retries a write, so a comment cannot be posted twice", async () => {
    const { client, fetch } = setup([json({ message: "Server Error" }, 502)]);
    await expect(client.createIssueComment("mdn", "content", 1, "x")).rejects.toMatchObject({ status: 502 });
    const network = setup([new TypeError("fetch failed")]);
    await expect(network.client.createIssueComment("mdn", "content", 1, "x")).rejects.toBeInstanceOf(NetworkError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rejected location as a 422 GitHubError", async () => {
    const { client } = setup([json({ message: "Validation Failed" }, 422)]);
    await expect(
      client.createReviewComment("mdn", "content", 1, {
        body: "b",
        commitId: HEAD,
        path: "a.md",
        line: 999,
        side: "RIGHT",
      }),
    ).rejects.toMatchObject({ status: 422, message: "Validation Failed" });
  });

  it("resolves and unresolves a review thread over GraphQL", async () => {
    const { client, request, fetch } = setup([
      json({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } }),
      json({ data: { unresolveReviewThread: { thread: { id: "PRRT_1", isResolved: false } } } }),
    ]);
    expect(await client.resolveReviewThread("PRRT_1")).toEqual({ nodeId: "PRRT_1", isResolved: true });
    expect(await client.unresolveReviewThread("PRRT_1")).toEqual({ nodeId: "PRRT_1", isResolved: false });
    expect(request(0).url).toBe("https://api.github.com/graphql");
    const first = sent(request(0).init);
    expect(first.query).toMatch(/resolveReviewThread\(input: \{ threadId: \$id \}\)/);
    expect(first.variables).toEqual({ id: "PRRT_1" });
    expect(sent(request(1).init).query).toMatch(/unresolveReviewThread/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("finds which pull request a review thread belongs to", async () => {
    const { client, request } = setup([
      json({ data: { node: { pullRequest: { number: 7, repository: { databaseId: 99 } } } } }),
      json({ data: { node: {} } }),
    ]);
    expect(await client.getReviewThreadPullRequest("PRRT_1")).toEqual({ repositoryId: 99, number: 7 });
    expect(sent(request(0).init).variables).toEqual({ id: "PRRT_1" });
    // Some other kind of node.
    expect(await client.getReviewThreadPullRequest("I_1")).toBeNull();
  });
});
