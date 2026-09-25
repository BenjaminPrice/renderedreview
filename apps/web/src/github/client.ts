// SPDX-License-Identifier: AGPL-3.0-only
// GitHub access from the browser. Signed out: direct first, same-origin proxy when direct access
// fails. Signed in: the authenticated same-origin endpoint, which reads with the user's token.
import { openBrowserCache } from "@rendered-review/browser-cache";
import {
  createGitHubClient,
  ForbiddenError,
  type GitHubClient,
  GitHubError,
  NetworkError,
  type RateLimit,
  RateLimitError,
  type ReviewThread,
} from "@rendered-review/github-integration";
import { RATE_LIMITED } from "../rate-limit";
import { apiBase, PROXY_PREFIX } from "./proxy";
import { PRIVATE_REPO_UNSUPPORTED, REQUESTED_WITH, TRIAL_EXPIRED, USER_PREFIX } from "./user-proxy";

/** Whose GitHub access a read uses: the signed-in user's, or public (anonymous/operator) access. */
export type Access = "user" | "public";

/** Local cache for public content. Memory-only where IndexedDB is missing (SSR). */
export const browserCache = openBrowserCache();
const cache = browserCache.responseCache({ private: false });

export type FallbackReason = "network" | "rate-limit";

/** Why a failed direct call should be retried through the proxy, or `undefined` if it should not. */
export function fallbackReason(error: unknown): FallbackReason | undefined {
  // Browsers report CORS rejections as plain network failures; the two are indistinguishable.
  if (error instanceof NetworkError) return "network";
  // The proxy serves REST only, and a GraphQL limit says nothing about the REST limit.
  if (error instanceof GitHubError && error.url.endsWith("/graphql")) return undefined;
  if (error instanceof RateLimitError) return "rate-limit";
  return undefined;
}

/** Rewrites GitHub API URLs (including pagination links) to the same-origin proxy. */
export const proxiedFetch =
  (host: string, fetchFn: typeof fetch = fetch): typeof fetch =>
  (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const base = `${apiBase(host)}/`;
    return fetchFn(url.startsWith(base) ? `${PROXY_PREFIX}${host}/${url.slice(base.length)}` : url, init);
  };

interface HostClients {
  direct: GitHubClient;
  proxy: GitHubClient;
  /** Epoch ms until which direct calls are skipped (anonymous limit exhausted). */
  proxyUntil: number;
}

let limitedUntil: Date | undefined;
const limitListeners = new Set<() => void>();
function noteRateLimit(resetAt: Date) {
  limitedUntil = resetAt;
  limitListeners.forEach((listener) => listener());
}

// The browser's own anonymous limit per host (per network), from direct responses' headers.
const guestLimits = new Map<string, RateLimit>();
function noteGuestLimit(host: string, limit: RateLimit) {
  guestLimits.set(host, limit);
  limitListeners.forEach((listener) => listener());
}

/**
 * When GitHub's rate limit last hit resets: pages show cached data until then. `guest(host)`: the
 * last observed anonymous limit for direct reads of `host`. Subscribe with `useSyncExternalStore`.
 */
export const rateLimit = {
  subscribe(listener: () => void) {
    limitListeners.add(listener);
    return () => limitListeners.delete(listener);
  },
  resetAt: () => limitedUntil,
  guest: (host: string) => guestLimits.get(host),
};

const clients = new Map<string, HostClients>();

function clientsFor(host: string): HostClients {
  let entry = clients.get(host);
  if (!entry) {
    entry = {
      // No retries on the direct path: a CORS failure would only repeat, and the proxy retries.
      direct: createGitHubClient({
        host,
        cache,
        maxRetries: 0,
        onMetric: (m) => m.rateLimit?.resource === "core" && noteGuestLimit(host, m.rateLimit),
      }),
      // The last resort: once it is rate-limited too, answer from the cache however old.
      proxy: createGitHubClient({
        host,
        cache,
        fetch: proxiedFetch(host),
        staleOnRateLimit: true,
        onMetric: (m) => m.outcome === "stale" && m.rateLimit && noteRateLimit(m.rateLimit.resetAt),
      }),
      proxyUntil: 0,
    };
    clients.set(host, entry);
  }
  return entry;
}

/** Sends `host` reads to the proxy first: the server reads it with a token, so it is not rate-limited like anonymous calls. */
export function preferProxy(host: string) {
  clientsFor(host).proxyUntil = Infinity;
}

/** Runs `call` against GitHub directly, retrying through the proxy for fallback-eligible failures. */
export async function withPublicGitHub<T>(host: string, call: (client: GitHubClient) => Promise<T>): Promise<T> {
  const entry = clientsFor(host);
  const viaProxy = () =>
    call(entry.proxy).catch((error: unknown) => {
      if (error instanceof RateLimitError) noteRateLimit(error.resetAt);
      throw error;
    });
  if (Date.now() < entry.proxyUntil) return viaProxy();
  try {
    return await call(entry.direct);
  } catch (error) {
    const reason = fallbackReason(error);
    if (!reason) throw error;
    // The browser sends no telemetry anywhere; this is a development aid only.
    if (import.meta.env.DEV) console.info(`github public fallback: ${reason}`);
    if (error instanceof RateLimitError) entry.proxyUntil = error.resetAt.getTime();
    return viaProxy();
  }
}

// Everything read with the user's access is per user, so it stays in memory for this tab (unless
// the user opts in to persisting private content), even for public repositories: the browser
// cannot know whether a repository is (still) public, and this rule needs no visibility tracking.
const userCache = browserCache.responseCache({ private: true });

/** Rewrites GitHub API URLs to the authenticated endpoint and marks the call as same-origin script. */
const userFetch =
  (host: string): typeof fetch =>
  (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const base = `${apiBase(host)}/`;
    const headers = new Headers(init?.headers);
    headers.set("X-Requested-With", REQUESTED_WITH);
    return fetch(url.startsWith(base) ? `${USER_PREFIX}${host}/${url.slice(base.length)}` : url, { ...init, headers });
  };

const userClients = new Map<string, GitHubClient>();

/** Runs `call` with `access`: the user's through the authenticated endpoint, or the public path. */
export function withGitHub<T>(access: Access, host: string, call: (client: GitHubClient) => Promise<T>): Promise<T> {
  if (access !== "user") return withPublicGitHub(host, call);
  let client = userClients.get(host);
  if (!client) userClients.set(host, (client = createGitHubClient({ host, cache: userCache, fetch: userFetch(host) })));
  return call(client);
}

/** Review threads with resolution state, read with the user's access. */
export async function userReviewThreads(
  host: string,
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewThread[]> {
  const url = `${apiBase(host)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/review-threads`;
  const res = await userFetch(host)(url).catch((cause: unknown) => {
    throw new NetworkError(url, cause);
  });
  if (!res.ok) {
    const { message } = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GitHubError(message ?? `GitHub responded ${res.status}`, res.status, url);
  }
  return res.json() as Promise<ReviewThread[]>;
}

/** The user's session or GitHub token is gone: they have to sign in again. */
export const isSignInRequired = (error: unknown) => error instanceof GitHubError && error.status === 401;

/** A signed-in read reached a private repository, which is not supported yet. */
export const isPrivateRepoUnsupported = (error: unknown) =>
  error instanceof ForbiddenError && error.message === PRIVATE_REPO_UNSUPPORTED;

/** A signed-in read reached a private repository whose owner's trial has ended. */
/** This app's own guest limit (its proxy's 429), as opposed to GitHub's. */
export const isAppRateLimited = (error: unknown): error is RateLimitError =>
  error instanceof RateLimitError && error.message === RATE_LIMITED;

export const isTrialExpired = (error: unknown) => error instanceof ForbiddenError && error.message === TRIAL_EXPIRED;
