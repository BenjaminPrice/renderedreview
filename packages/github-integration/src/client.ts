// SPDX-License-Identifier: AGPL-3.0-only
// Read-only GitHub REST/GraphQL client built on `fetch` alone, so the same code runs in browsers,
// Node and Workers.
import {
  type ChangedFile,
  type IssueComment,
  type PullRequest,
  type Raw,
  type Review,
  type ReviewComment,
  type ReviewThread,
  type Tree,
  toChangedFile,
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
  outcome: "ok" | "not-modified" | "retry" | "error";
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

async function toError(res: Response, url: string, rateLimit: RateLimit | undefined): Promise<GitHubError> {
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
    if (rateLimit?.remaining === 0) return new RateLimitError(message, res.status, url, requestId, rateLimit.resetAt);
    // Secondary limits without Retry-After: GitHub asks clients to wait at least a minute.
    if (/rate limit/i.test(message)) {
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
    method: "GET" | "POST",
    url: string,
    accept = JSON_MEDIA,
    body?: string,
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
        const again = attempt < maxRetries;
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
      const again = RETRYABLE.has(res.status) && attempt < maxRetries;
      emit(res.status, again ? "retry" : "error", rl);
      if (again) {
        await retry();
        continue;
      }
      throw await toError(res, url, rl);
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

  async function graphql(query: string, variables: Record<string, unknown>): Promise<Raw> {
    const { body } = (await send("POST", graphqlUrl, "application/json", JSON.stringify({ query, variables }))) as {
      body: Raw;
    };
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
  };
}

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
