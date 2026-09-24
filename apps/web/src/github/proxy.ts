// SPDX-License-Identifier: AGPL-3.0-only
// Same-origin fallback for public GitHub reads the browser could not make directly (CORS, network,
// anonymous rate limit). Forwards only allowlisted read-only REST paths, anonymously or with the
// operator's public read token, and never serves a private repository. Never an open proxy. Web Request/Response/fetch only, so it runs on Node and Workers alike.
import type { AppConfig } from "@rendered-review/runtime";

export const PROXY_PREFIX = "/api/github/public/";

/** GitHub hosts this deployment serves: github.com, plus the configured Enterprise Server host. */
export const allowedHosts = (config: AppConfig) => [...new Set(["github.com", new URL(config.github.url).host])];

/** Hosts where the browser should use the proxy first because the server reads them with a token. */
export const proxyFirstHosts = (config: AppConfig) =>
  config.github.publicReadToken ? [new URL(config.github.url).host] : [];

const REPO = String.raw`(?:repos/(?!\.\.?/)[\w.-]{1,100}/(?!\.\.?/)[\w.-]{1,100}|repositories/\d{1,12})`;
const REPO_PREFIX = new RegExp(`^${REPO}`);
const OID = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
const MUTABLE = new RegExp(
  String.raw`^${REPO}/(?:pulls/\d{1,10}(?:/(?:files|comments|reviews))?|issues/\d{1,10}/comments)$`,
);
// Trees and blobs are only proxied by full OID, so the content behind a URL can never change.
const IMMUTABLE = new RegExp(String.raw`^${REPO}/git/(?:trees|blobs)/${OID}$`);
const QUERY: Record<string, RegExp> = { per_page: /^\d{1,3}$/, page: /^\d{1,6}$/, recursive: /^1$/ };
const ACCEPT = new Set(["application/vnd.github+json", "application/vnd.github.raw+json"]);
const FORWARD_RESPONSE = [
  "content-type",
  "etag",
  "link",
  "retry-after",
  "x-github-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-used",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
];

export const apiBase = (host: string) => (host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`);

/** Classifies `path` (no leading slash) and query; `undefined` when not allowlisted. */
export function classifyPath(path: string, query: URLSearchParams): "immutable" | "mutable" | undefined {
  for (const [key, value] of query) if (!QUERY[key]?.test(value)) return undefined;
  if (IMMUTABLE.test(path)) return "immutable";
  if (MUTABLE.test(path)) return "mutable";
  return undefined;
}

const reject = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { "cache-control": "no-store" } });

const VISIBILITY_TTL_MS = 5 * 60_000;
// ponytail: per-process map cleared when full; a shared cache if many instances hammer the lookup.
const visibility = new Map<string, { public: boolean; until: number }>();

/**
 * A token may read private repositories, so token-backed reads first confirm the repository is
 * public. Lookup failures count as not public and are not cached.
 */
async function isPublicRepo(
  host: string,
  repo: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const key = `${host}/${repo.toLowerCase()}`;
  const hit = visibility.get(key);
  if (hit && hit.until > Date.now()) return hit.public;
  const res = await fetchFn(`${apiBase(host)}/${repo}`, {
    headers: { ...headers, Accept: "application/vnd.github+json" },
  }).catch(() => undefined);
  if (res?.status !== 200) return false;
  const body = (await res.json().catch(() => undefined)) as { private?: unknown; visibility?: unknown } | undefined;
  const isPublic = body?.private === false && (body.visibility ?? "public") === "public";
  if (visibility.size >= 10_000) visibility.clear();
  visibility.set(key, { public: isPublic, until: Date.now() + VISIBILITY_TTL_MS });
  return isPublic;
}

export async function proxyPublicGitHub(
  request: Request,
  {
    allowedHosts,
    readToken,
    fetch: fetchFn = fetch,
  }: {
    allowedHosts: string[];
    /** Operator token, sent only to its own host. */
    readToken?: { host: string; token: string };
    fetch?: typeof fetch;
  },
): Promise<Response> {
  if (request.method !== "GET") return reject(405, "Method not allowed");
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PROXY_PREFIX)) return reject(404, "Not found");
  const rest = url.pathname.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  const host = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (slash < 0 || !allowedHosts.includes(host)) return reject(403, "GitHub host not allowed");
  const kind = classifyPath(path, url.searchParams);
  if (!kind) return reject(403, "Path not allowed");

  const accept = request.headers.get("accept") ?? "";
  const headers: Record<string, string> = {
    Accept: ACCEPT.has(accept) ? accept : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rendered-review",
  };
  if (readToken?.host === host) {
    headers.Authorization = `Bearer ${readToken.token}`;
    const repo = REPO_PREFIX.exec(path)![0];
    if (!(await isPublicRepo(host, repo, headers, fetchFn))) return reject(404, "Not found");
  }
  const etag = request.headers.get("if-none-match");
  if (etag) headers["If-None-Match"] = etag;

  // Renamed repositories answer with a redirect to `/repositories/<id>/...` on the same API host.
  const upstream = await fetchFn(`${apiBase(host)}/${path}${url.search}`, { headers });
  const out = new Headers({ vary: "Accept, If-None-Match" });
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  out.set(
    "cache-control",
    upstream.status !== 200 && upstream.status !== 304
      ? "no-store"
      : kind === "immutable"
        ? "public, max-age=31536000, immutable"
        : "public, max-age=30, must-revalidate",
  );
  return new Response(upstream.status === 304 ? null : upstream.body, { status: upstream.status, headers: out });
}
