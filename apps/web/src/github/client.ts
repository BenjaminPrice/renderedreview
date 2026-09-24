// SPDX-License-Identifier: AGPL-3.0-only
// Public GitHub access from the browser: direct first, same-origin proxy when direct access fails.
import { openBrowserCache } from "@rendered-review/browser-cache";
import {
  createGitHubClient,
  type GitHubClient,
  GitHubError,
  NetworkError,
  RateLimitError,
} from "@rendered-review/github-integration";
import { apiBase, PROXY_PREFIX } from "./proxy";

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

/** When GitHub's rate limit last hit resets: pages show cached data until then. Subscribe with `useSyncExternalStore`. */
export const rateLimit = {
  subscribe(listener: () => void) {
    limitListeners.add(listener);
    return () => limitListeners.delete(listener);
  },
  resetAt: () => limitedUntil,
};

const clients = new Map<string, HostClients>();

function clientsFor(host: string): HostClients {
  let entry = clients.get(host);
  if (!entry) {
    entry = {
      // No retries on the direct path: a CORS failure would only repeat, and the proxy retries.
      direct: createGitHubClient({ host, cache, maxRetries: 0 }),
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
    console.info(`github public fallback: ${reason}`);
    if (error instanceof RateLimitError) entry.proxyUntil = error.resetAt.getTime();
    return viaProxy();
  }
}
