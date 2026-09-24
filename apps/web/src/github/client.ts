// SPDX-License-Identifier: AGPL-3.0-only
// Public GitHub access from the browser: direct first, same-origin proxy when direct access fails.
import {
  type CacheEntry,
  createGitHubClient,
  type GitHubClient,
  NetworkError,
  RateLimitError,
  type ResponseCache,
} from "@rendered-review/github-integration";
import { apiBase, PROXY_PREFIX } from "./proxy";

// ponytail: in-memory ETag cache; swap for the IndexedDB cache when it lands.
const cache: ResponseCache = new Map<string, CacheEntry>();

export type FallbackReason = "network" | "rate-limit";

/** Why a failed direct call should be retried through the proxy, or `undefined` if it should not. */
export function fallbackReason(error: unknown): FallbackReason | undefined {
  // Browsers report CORS rejections as plain network failures; the two are indistinguishable.
  if (error instanceof NetworkError) return "network";
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

const clients = new Map<string, HostClients>();

function clientsFor(host: string): HostClients {
  let entry = clients.get(host);
  if (!entry) {
    entry = {
      // No retries on the direct path: a CORS failure would only repeat, and the proxy retries.
      direct: createGitHubClient({ host, cache, maxRetries: 0 }),
      proxy: createGitHubClient({ host, cache, fetch: proxiedFetch(host) }),
      proxyUntil: 0,
    };
    clients.set(host, entry);
  }
  return entry;
}

/** Runs `call` against GitHub directly, retrying through the proxy for fallback-eligible failures. */
export async function withPublicGitHub<T>(host: string, call: (client: GitHubClient) => Promise<T>): Promise<T> {
  const entry = clientsFor(host);
  if (Date.now() < entry.proxyUntil) return call(entry.proxy);
  try {
    return await call(entry.direct);
  } catch (error) {
    const reason = fallbackReason(error);
    if (!reason) throw error;
    console.info(`github public fallback: ${reason}`);
    if (error instanceof RateLimitError) entry.proxyUntil = error.resetAt.getTime();
    return call(entry.proxy);
  }
}
