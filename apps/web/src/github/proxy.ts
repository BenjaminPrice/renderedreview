// SPDX-License-Identifier: AGPL-3.0-only
// Same-origin fallback for public GitHub reads the browser could not make directly (CORS, network,
// anonymous rate limit). Forwards only allowlisted read-only REST paths, anonymously or with the
// operator's public read token, and never serves a private repository. Never an open proxy. Web Request/Response/fetch only, so it runs on Node and Workers alike.
import type { AppConfig } from "@rendered-review/runtime";
import { type RateLimited, rateLimitedResponse } from "../rate-limit";
import { forRepository } from "./broker";
import { meteredFetch } from "./metrics";

export const PROXY_PREFIX = "/api/github/public/";

/** GitHub hosts this deployment serves: github.com, plus the configured Enterprise Server host. */
export const allowedHosts = (config: AppConfig) => [...new Set(["github.com", new URL(config.github.url).host])];

/** Hosts where the browser should use the proxy first because the server reads them with a token. */
export const proxyFirstHosts = (config: AppConfig) =>
  config.github.publicReadToken ? [new URL(config.github.url).host] : [];

export const REPO_SEGMENT = String.raw`(?!\.\.?/)[\w.-]{1,100}`;
const REPO = String.raw`(?:repos/${REPO_SEGMENT}/${REPO_SEGMENT}|repositories/\d{1,12})`;
export const REPO_PREFIX = new RegExp(`^${REPO}`);
const OID = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
const MUTABLE = new RegExp(
  String.raw`^${REPO}/(?:pulls/\d{1,10}(?:/(?:files|comments|reviews|commits))?|issues/\d{1,10}/comments)$`,
);
// Trees and blobs are only proxied by full OID, so the content behind a URL can never change.
const IMMUTABLE = new RegExp(String.raw`^${REPO}/git/(?:trees|blobs)/${OID}$`);
// A file at a commit, by full commit OID only (`ref`), so it is as immutable as a blob.
const CONTENTS = new RegExp(String.raw`^${REPO}/contents/(.+)$`);
const FULL_OID = new RegExp(`^${OID}$`);
/**
 * The file path re-encoded from its decoded names, or `undefined` unless every segment decodes
 * to a plain name: no traversal, no smuggled separators, and no `%` left over (a double-encoded
 * name could decode again upstream). What was validated is exactly what is forwarded.
 */
function plainFilePath(path: string): string | undefined {
  const names: string[] = [];
  for (const segment of path.split("/")) {
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (name === "" || name === "." || name === ".." || /[/\\%\0]/.test(name)) return undefined;
    names.push(encodeURIComponent(name));
  }
  return names.join("/");
}
const QUERY: Record<string, RegExp> = { per_page: /^\d{1,3}$/, page: /^\d{1,6}$/, recursive: /^1$/ };
export const ACCEPT = new Set(["application/vnd.github+json", "application/vnd.github.raw+json"]);
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

/**
 * Classifies `path` (no leading slash) and query; `undefined` when not allowlisted. `path` is the
 * canonical form to forward.
 */
export function classifyPath(
  path: string,
  query: URLSearchParams,
): { kind: "immutable" | "mutable"; path: string } | undefined {
  const contents = CONTENTS.exec(path);
  if (contents) {
    const [only, ...rest] = query;
    const file = only?.[0] === "ref" && FULL_OID.test(only[1]) && rest.length === 0 && plainFilePath(contents[1]!);
    return file ? { kind: "immutable", path: path.slice(0, -contents[1]!.length) + file } : undefined;
  }
  for (const [key, value] of query) if (!QUERY[key]?.test(value)) return undefined;
  if (IMMUTABLE.test(path)) return { kind: "immutable", path };
  if (MUTABLE.test(path)) return { kind: "mutable", path };
  return undefined;
}

export const reject = (status: number, message: string, code?: string) =>
  Response.json({ message, ...(code && { code }) }, { status, headers: { "cache-control": "no-store" } });

/** Splits `<prefix><host>/<path>` and checks the host; a rejection `Response` otherwise. */
export function parseProxyPath(url: URL, prefix: string, hosts: string[]): { host: string; path: string } | Response {
  if (!url.pathname.startsWith(prefix)) return reject(404, "Not found");
  const rest = url.pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const host = rest.slice(0, slash);
  if (slash < 0 || !hosts.includes(host)) return reject(403, "GitHub host not allowed");
  return { host, path: rest.slice(slash + 1) };
}

/** The allowlisted upstream response headers. */
export function forwardHeaders(upstream: Response, extra: Record<string, string>): Headers {
  const out = new Headers(extra);
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

const VISIBILITY_TTL_MS = 5 * 60_000;

/** A repository's visibility and its current owner (absent if GitHub's answer lacks one). */
export interface RepoFacts {
  visibility: "public" | "private";
  /** GitHub's repository ID. */
  id?: number;
  name?: string;
  owner?: { id: string; login: string; type: "User" | "Organization" };
}
// ponytail: per-process map cleared when full; a shared cache if many instances hammer the lookup.
const visibility = new Map<string, RepoFacts & { until: number }>();

function ownerOf(value: unknown): RepoFacts["owner"] {
  const o = value as { id?: unknown; login?: unknown; type?: unknown } | undefined;
  if (!Number.isSafeInteger(o?.id) || typeof o?.login !== "string") return undefined;
  if (o.type !== "User" && o.type !== "Organization") return undefined;
  return { id: String(o.id), login: o.login, type: o.type };
}

/**
 * A token may read private repositories, so token-backed reads first confirm the repository is
 * public. `repo` is the path's repository prefix. A failed lookup returns GitHub's response (or a
 * 502 when unreachable) and is not cached.
 */
export async function repoFacts(
  host: string,
  repo: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  /**
   * False where a private answer leads to a per-viewer decision: the cache is shared by every
   * viewer, so a private repository is read again with this viewer's token, and a viewer GitHub
   * would not show it gets GitHub's own answer.
   */
  privateFromCache = true,
): Promise<RepoFacts | Response> {
  const key = `${host}/${repo.toLowerCase()}`;
  const hit = visibility.get(key);
  if (hit && hit.until > Date.now() && (privateFromCache || hit.visibility === "public"))
    return { visibility: hit.visibility, id: hit.id, name: hit.name, owner: hit.owner };
  const res = await fetchFn(`${apiBase(host)}/${repo}`, {
    headers: { ...headers, Accept: "application/vnd.github+json" },
  }).catch(() => undefined);
  if (!res) return reject(502, "GitHub unreachable");
  if (res.status !== 200) return res;
  const body = (await res.json().catch(() => undefined)) as
    { id?: unknown; private?: unknown; visibility?: unknown; name?: unknown; owner?: unknown } | undefined;
  const isPublic = body?.private === false && (body.visibility ?? "public") === "public";
  const facts: RepoFacts = {
    visibility: isPublic ? "public" : "private",
    id: Number.isSafeInteger(body?.id) ? (body!.id as number) : undefined,
    name: typeof body?.name === "string" ? body.name : undefined,
    owner: ownerOf(body?.owner),
  };
  if (visibility.size >= 10_000) visibility.clear();
  visibility.set(key, { ...facts, until: Date.now() + VISIBILITY_TTL_MS });
  return facts;
}

export async function repoVisibility(
  host: string,
  repo: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<RepoFacts["visibility"] | Response> {
  const facts = await repoFacts(host, repo, headers, fetchFn);
  return facts instanceof Response ? facts : facts.visibility;
}

export async function proxyPublicGitHub(
  request: Request,
  {
    allowedHosts,
    readToken,
    fetch: unmetered = fetch,
    limit,
  }: {
    allowedHosts: string[];
    /** Operator token, sent only to its own host. */
    readToken?: { host: string; token: string };
    fetch?: typeof fetch;
    /** Counts this request against the client's guest limit (it protects the operator token's quota). */
    limit?: () => Promise<RateLimited | undefined>;
  },
): Promise<Response> {
  const hit = await limit?.();
  if (hit) return rateLimitedResponse(hit);
  if (request.method !== "GET") return reject(405, "Method not allowed");
  const fetchFn = meteredFetch(unmetered);
  const url = new URL(request.url);
  const target = parseProxyPath(url, PROXY_PREFIX, allowedHosts);
  if (target instanceof Response) return target;
  const allowed = classifyPath(target.path, url.searchParams);
  if (!allowed) return reject(403, "Path not allowed");
  const { host } = target;
  const { kind, path } = allowed;

  const accept = request.headers.get("accept") ?? "";
  const headers: Record<string, string> = {
    Accept: ACCEPT.has(accept) ? accept : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rendered-review",
  };
  // No user here: the operator token (public repositories only) or anonymous.
  const credential = await forRepository({ host, owner: "", repo: "", operation: "read" }, { readToken });
  if (credential.kind !== "anonymous") {
    headers.Authorization = `Bearer ${credential.token}`;
    const repo = REPO_PREFIX.exec(path)![0];
    if ((await repoVisibility(host, repo, headers, fetchFn)) !== "public") return reject(404, "Not found");
  }
  const etag = request.headers.get("if-none-match");
  if (etag) headers["If-None-Match"] = etag;

  // Renamed repositories answer with a redirect to `/repositories/<id>/...` on the same API host.
  const upstream = await fetchFn(`${apiBase(host)}/${path}${url.search}`, { headers });
  const out = forwardHeaders(upstream, { vary: "Accept, If-None-Match" });
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
