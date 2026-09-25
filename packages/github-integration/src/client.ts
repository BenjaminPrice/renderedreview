// SPDX-License-Identifier: AGPL-3.0-only
// GitHub REST/GraphQL client built on `fetch` alone, so the same code runs in browsers,
// Node and Workers.
import {
  type Actor,
  actor,
  type ChangedFile,
  type IssueComment,
  type PullRequest,
  type PullRequestCommit,
  type Raw,
  type Review,
  type ReviewComment,
  type ReviewThread,
  type Tree,
  toChangedFile,
  toPullRequestCommit,
  toIssueComment,
  toPullRequest,
  toReview,
  toReviewComment,
  toReviewThread,
  toTree,
} from "./types";

/** A cached response body. `next` is the pagination link that came with it. */
export interface CacheEntry {
  etag: string;
  body: unknown;
  next?: string;
}

/**
 * ETag cache. Keys already include the auth scope, media type and URL. A `Map` satisfies this;
 * wrap IndexedDB for persistence. Callers decide whether private content may be cached at all.
 */
export interface ResponseCache {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): unknown;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  used: number;
  resetAt: Date;
  /** "core", "graphql", "search", ... */
  resource: string;
}

export interface RequestMetric {
  method: string;
  url: string;
  /** 0 when the request never got a response. */
  status: number;
  durationMs: number;
  /** 0 for the first try. */
  attempt: number;
  /** "stale": rate-limited, answered from the cache (`staleOnRateLimit`). */
  outcome: "ok" | "not-modified" | "stale" | "retry" | "error";
  rateLimit?: RateLimit;
}

export interface GitHubClientOptions {
  /** "github.com" (default) or a GitHub Enterprise Server hostname. */
  host?: string;
  fetch?: typeof fetch;
  /** Returns the Authorization header value, e.g. `Bearer <token>`. Omit for anonymous access. */
  auth?: () => string | undefined | Promise<string | undefined>;
  cache?: ResponseCache;
  onMetric?: (metric: RequestMetric) => void;
  /**
   * When rate-limited, answer GET requests from the cache, however old, instead of throwing a
   * `RateLimitError`; reported with outcome "stale". Throws as usual when nothing is cached.
   */
  staleOnRateLimit?: boolean;
  /** Retries for network errors and 5xx on these read-only requests. Default 2. */
  maxRetries?: number;
  /** First backoff delay; doubles each retry. Default 500 ms. */
  retryDelayMs?: number;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class NotFoundError extends GitHubError {}
export class ForbiddenError extends GitHubError {}
export class NetworkError extends GitHubError {
  constructor(url: string, cause: unknown) {
    super(`Network error requesting ${url}`, 0, url);
    this.cause = cause;
  }
}
export class RateLimitError extends GitHubError {
  constructor(
    message: string,
    status: number,
    url: string,
    requestId: string | undefined,
    /** When the caller may try again. */
    readonly resetAt: Date,
  ) {
    super(message, status, url, requestId);
  }
}

const RAW = "application/vnd.github.raw+json";
const JSON_MEDIA = "application/vnd.github+json";
const RETRYABLE = new Set([500, 502, 503, 504]);

const seg = encodeURIComponent;
const filePath = (path: string) => path.split("/").map(seg).join("/");

function parseRateLimit(h: Headers): RateLimit | undefined {
  const limit = h.get("x-ratelimit-limit");
  if (limit === null) return undefined;
  return {
    limit: Number(limit),
    remaining: Number(h.get("x-ratelimit-remaining")),
    used: Number(h.get("x-ratelimit-used")),
    resetAt: new Date(Number(h.get("x-ratelimit-reset")) * 1000),
    resource: h.get("x-ratelimit-resource") ?? "core",
  };
}

async function authScope(authorization: string | undefined): Promise<string> {
  if (!authorization) return "anon";
  // ponytail: token rotation (e.g. hourly installation tokens) starts a fresh cache scope; pass a
  // stable scope option if that hit rate matters.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function toError(
  res: Response,
  url: string,
  rateLimit: RateLimit | undefined,
  rest: boolean,
): Promise<GitHubError> {
  const requestId = res.headers.get("x-github-request-id") ?? undefined;
  const message: string =
    (await res
      .json()
      .then((b: Raw) => b?.message)
      .catch(() => undefined)) ?? `GitHub responded ${res.status}`;
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter !== null) {
      return new RateLimitError(message, res.status, url, requestId, new Date(Date.now() + Number(retryAfter) * 1000));
    }
    // Only REST reports exhaustion this way: anonymous GraphQL answers 403 with a zero limit.
    if (rest && rateLimit?.remaining === 0)
      return new RateLimitError(message, res.status, url, requestId, rateLimit.resetAt);
    // Secondary limits without Retry-After: GitHub asks clients to wait at least a minute.
    if (rest && /rate limit/i.test(message)) {
      return new RateLimitError(message, res.status, url, requestId, new Date(Date.now() + 60_000));
    }
  }
  if (res.status === 404) return new NotFoundError(message, 404, url, requestId);
  if (res.status === 403) return new ForbiddenError(message, 403, url, requestId);
  return new GitHubError(message, res.status, url, requestId);
}

export function createGitHubClient(options: GitHubClientOptions = {}) {
  const host = options.host ?? "github.com";
  const restBase = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  const graphqlUrl = host === "github.com" ? "https://api.github.com/graphql" : `https://${host}/api/graphql`;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;
  let rateLimit: RateLimit | undefined;

  async function send(
    method: "GET" | "POST" | "PATCH",
    url: string,
    accept = JSON_MEDIA,
    body?: string,
    // Writes pass 0: a retried POST could publish the same comment twice.
    retries = maxRetries,
  ): Promise<{ body: unknown; next?: string }> {
    const authorization = await options.auth?.();
    const key = options.cache && method === "GET" ? `${await authScope(authorization)} ${accept} ${url}` : undefined;
    const cached = key ? await options.cache!.get(key) : undefined;
    const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
    if (authorization) headers.Authorization = authorization;
    if (cached) headers["If-None-Match"] = cached.etag;
    if (body) headers["Content-Type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const emit = (status: number, outcome: RequestMetric["outcome"], rl?: RateLimit) =>
        options.onMetric?.({
          method,
          url,
          status,
          durationMs: performance.now() - started,
          attempt,
          outcome,
          ...(rl && { rateLimit: rl }),
        });
      const retry = async () => {
        await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** attempt));
      };

      let res: Response;
      try {
        res = await fetchFn(url, { method, headers, body });
      } catch (cause) {
        const again = attempt < retries;
        emit(0, again ? "retry" : "error");
        if (again) {
          await retry();
          continue;
        }
        throw new NetworkError(url, cause);
      }

      const rl = parseRateLimit(res.headers);
      if (rl) rateLimit = rl;
      if (res.status === 304 && cached) {
        emit(304, "not-modified", rl);
        return cached;
      }
      if (res.ok) {
        const data: unknown = accept === RAW ? await res.text() : await res.json();
        const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
        const etag = res.headers.get("etag");
        if (key && etag) await options.cache!.set(key, { etag, body: data, ...(next && { next }) });
        emit(res.status, "ok", rl);
        return { body: data, ...(next && { next }) };
      }
      if (RETRYABLE.has(res.status) && attempt < retries) {
        emit(res.status, "retry", rl);
        await retry();
        continue;
      }
      const error = await toError(res, url, rl, url !== graphqlUrl);
      if (error instanceof RateLimitError && cached && options.staleOnRateLimit) {
        // Retry-After limits come without rate-limit headers; the reset time is what matters.
        const limit = rl ?? { limit: 0, remaining: 0, used: 0, resource: "core" };
        emit(res.status, "stale", { ...limit, resetAt: error.resetAt });
        return cached;
      }
      emit(res.status, "error", rl);
      throw error;
    }
  }

  const get = async (path: string, accept?: string) => (await send("GET", restBase + path, accept)).body as Raw;

  async function paginate(path: string): Promise<Raw[]> {
    const items: Raw[] = [];
    let url: string | undefined = `${restBase}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (url) {
      const page: { body: unknown; next?: string } = await send("GET", url);
      items.push(...(page.body as Raw[]));
      url = page.next;
    }
    return items;
  }

  async function graphql(query: string, variables: Record<string, unknown>, retries = maxRetries): Promise<Raw> {
    const { body } = (await send(
      "POST",
      graphqlUrl,
      "application/json",
      JSON.stringify({ query, variables }),
      retries,
    )) as { body: Raw };
    const error = body.errors?.[0];
    if (error) {
      const message: string = error.message;
      if (error.type === "RATE_LIMITED") {
        throw new RateLimitError(
          message,
          200,
          graphqlUrl,
          undefined,
          rateLimit?.resetAt ?? new Date(Date.now() + 60_000),
        );
      }
      if (error.type === "NOT_FOUND") throw new NotFoundError(message, 200, graphqlUrl);
      if (error.type === "FORBIDDEN") throw new ForbiddenError(message, 200, graphqlUrl);
      throw new GitHubError(message, 200, graphqlUrl);
    }
    return body.data;
  }

  const repo = (owner: string, name: string) => `/repos/${seg(owner)}/${seg(name)}`;
  const post = async (path: string, payload: object) =>
    (await send("POST", restBase + path, JSON_MEDIA, JSON.stringify(payload), 0)).body as Raw;
  const patch = async (path: string, payload: object) =>
    (await send("PATCH", restBase + path, JSON_MEDIA, JSON.stringify(payload), 0)).body as Raw;
  /** The number at the end of a comment's issue or pull request API URL. */
  const numberIn = (url: unknown) => Number(/\/(\d+)$/.exec(String(url))?.[1] ?? NaN);
  const pull = (owner: string, name: string, number: number) => `${repo(owner, name)}/pulls/${number}`;
  const setResolved = async (mutation: string, id: string) => {
    const { thread } = (
      await graphql(
        `mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { id isResolved } } }`,
        { id },
        0,
      )
    )[mutation];
    return { nodeId: thread.id as string, isResolved: thread.isResolved as boolean };
  };

  return {
    /** Rate-limit headers from the most recent response. */
    get rateLimit(): RateLimit | undefined {
      return rateLimit;
    },

    getPullRequest: async (owner: string, name: string, number: number): Promise<PullRequest> =>
      toPullRequest(await get(`${repo(owner, name)}/pulls/${number}`)),

    listPullRequestFiles: async (owner: string, name: string, number: number): Promise<ChangedFile[]> =>
      (await paginate(`${repo(owner, name)}/pulls/${number}/files`)).map(toChangedFile),

    /** `treeOid` may also be a commit OID. */
    /** Up to 250 commits, oldest first (GitHub's limit for this list). */
    listPullRequestCommits: async (owner: string, name: string, number: number): Promise<PullRequestCommit[]> =>
      (await paginate(`${repo(owner, name)}/pulls/${number}/commits`)).map(toPullRequestCommit),
    getTree: async (owner: string, name: string, treeOid: string, { recursive = false } = {}): Promise<Tree> =>
      toTree(await get(`${repo(owner, name)}/git/trees/${seg(treeOid)}${recursive ? "?recursive=1" : ""}`)),

    /** Raw blob text (e.g. Markdown) by blob OID. */
    getBlob: async (owner: string, name: string, blobOid: string): Promise<string> =>
      get(`${repo(owner, name)}/git/blobs/${seg(blobOid)}`, RAW),

    /** Raw file text at a commit OID (or any ref; use OIDs for immutable caching). */
    getFileContents: async (owner: string, name: string, path: string, ref: string): Promise<string> =>
      get(`${repo(owner, name)}/contents/${filePath(path)}?ref=${seg(ref)}`, RAW),

    listReviewComments: async (owner: string, name: string, number: number): Promise<ReviewComment[]> =>
      (await paginate(`${repo(owner, name)}/pulls/${number}/comments`)).map(toReviewComment),

    listReviews: async (owner: string, name: string, number: number): Promise<Review[]> =>
      (await paginate(`${repo(owner, name)}/pulls/${number}/reviews`)).map(toReview),

    listIssueComments: async (owner: string, name: string, number: number): Promise<IssueComment[]> =>
      (await paginate(`${repo(owner, name)}/issues/${number}/comments`)).map(toIssueComment),

    /** Review-thread resolution state. GraphQL, so it needs `auth`; GitHub rejects anonymous calls. */
    async listReviewThreads(owner: string, name: string, number: number): Promise<ReviewThread[]> {
      const threads: ReviewThread[] = [];
      let after: string | null = null;
      do {
        const data = await graphql(REVIEW_THREADS, { owner, name, number, after });
        const page = data.repository.pullRequest.reviewThreads;
        threads.push(...page.nodes.map(toReviewThread));
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      return threads;
    },

    // Writes: never retried, never cached. They notify people, so GitHub may apply secondary rate limits.

    /** A review comment on diff lines, or on the whole file when `line` is omitted. */
    createReviewComment: async (
      owner: string,
      name: string,
      number: number,
      c: { body: string; commitId: string; path: string } & Partial<LineRange>,
    ): Promise<ReviewComment> =>
      toReviewComment(
        await post(`${pull(owner, name, number)}/comments`, {
          body: c.body,
          commit_id: c.commitId,
          path: c.path,
          ...(c.line === undefined ? { subject_type: "file" } : lineFields(c as LineRange)),
        }),
      ),

    /** Replies to the thread started by top-level review comment `commentId`. */
    replyToReviewComment: async (
      owner: string,
      name: string,
      number: number,
      commentId: number,
      body: string,
    ): Promise<ReviewComment> =>
      toReviewComment(await post(`${pull(owner, name, number)}/comments/${commentId}/replies`, { body })),

    /**
     * Submits a review. `comments` are line comments only: the batch endpoint takes no `subject_type`,
     * so file-level comments go through `createReviewComment`.
     */
    createReview: async (
      owner: string,
      name: string,
      number: number,
      r: {
        commitId: string;
        event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
        body?: string;
        comments: ({ path: string; body: string } & LineRange)[];
      },
    ): Promise<Review> =>
      toReview(
        await post(`${pull(owner, name, number)}/reviews`, {
          commit_id: r.commitId,
          event: r.event,
          ...(r.body && { body: r.body }),
          comments: r.comments.map((c) => ({ path: c.path, body: c.body, ...lineFields(c) })),
        }),
      ),

    /** A PR conversation comment. */
    createIssueComment: async (owner: string, name: string, number: number, body: string): Promise<IssueComment> =>
      toIssueComment(await post(`${repo(owner, name)}/issues/${number}/comments`, { body })),

    /** The user the credential acts for. */
    getAuthenticatedUser: async (): Promise<Actor> => actor(await get("/user"))!,

    /** A PR conversation comment, with the number of the pull request (issue) it is on. */
    getIssueComment: async (
      owner: string,
      name: string,
      id: number,
    ): Promise<IssueComment & { pullRequest: number }> => {
      const raw = await get(`${repo(owner, name)}/issues/comments/${id}`);
      return { ...toIssueComment(raw), pullRequest: numberIn(raw.issue_url) };
    },

    /** A review comment, with the number of the pull request it is on. */
    getReviewComment: async (
      owner: string,
      name: string,
      id: number,
    ): Promise<ReviewComment & { pullRequest: number }> => {
      const raw = await get(`${repo(owner, name)}/pulls/comments/${id}`);
      return { ...toReviewComment(raw), pullRequest: numberIn(raw.pull_request_url) };
    },

    /** Replaces a PR conversation comment's body. */
    updateIssueComment: async (owner: string, name: string, id: number, body: string): Promise<IssueComment> =>
      toIssueComment(await patch(`${repo(owner, name)}/issues/comments/${id}`, { body })),

    /** Replaces a review comment's body. */
    updateReviewComment: async (owner: string, name: string, id: number, body: string): Promise<ReviewComment> =>
      toReviewComment(await patch(`${repo(owner, name)}/pulls/comments/${id}`, { body })),

    resolveReviewThread: (threadNodeId: string) => setResolved("resolveReviewThread", threadNodeId),
    unresolveReviewThread: (threadNodeId: string) => setResolved("unresolveReviewThread", threadNodeId),

    /** The pull request a review thread belongs to; `null` when the node is not a review thread. */
    async getReviewThreadPullRequest(threadNodeId: string): Promise<{ repositoryId: number; number: number } | null> {
      const { node } = await graphql(THREAD_PULL_REQUEST, { id: threadNodeId });
      const pr = node?.pullRequest;
      return pr ? { repositoryId: pr.repository.databaseId, number: pr.number } : null;
    },
  };
}

/** GitHub's `line`/`side` (the range's last line) and, for multi-line ranges, `start_line`/`start_side`. */
export interface LineRange {
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
}

const lineFields = (r: LineRange) => ({
  line: r.line,
  side: r.side,
  ...(r.startLine !== undefined && { start_line: r.startLine, start_side: r.startSide ?? r.side }),
});

const THREAD_PULL_REQUEST = `query($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { databaseId } } } }
}`;

export type GitHubClient = ReturnType<typeof createGitHubClient>;

// ponytail: only the first 100 comment ids per thread; page thread comments if a thread ever exceeds that.
const REVIEW_THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide subjectType
          resolvedBy { login }
          comments(first: 100) { nodes { databaseId } }
        }
      }
    }
  }
}`;
