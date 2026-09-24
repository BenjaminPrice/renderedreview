// SPDX-License-Identifier: AGPL-3.0-only
// Same-origin fallback for public GitHub reads the browser could not make directly (CORS, network,
// anonymous rate limit). Forwards only allowlisted read-only REST paths, anonymously. Never an open
// proxy. Web Request/Response/fetch only, so it runs on Node and Workers alike.

export const PROXY_PREFIX = "/api/github/public/";

// ponytail: fixed allowlist; read GitHub Enterprise Server hosts from runtime config once it exists.
export const ALLOWED_HOSTS = ["github.com"];

const REPO = String.raw`(?:repos/(?!\.\.?/)[\w.-]{1,100}/(?!\.\.?/)[\w.-]{1,100}|repositories/\d{1,12})`;
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

export async function proxyPublicGitHub(
  request: Request,
  { allowedHosts = ALLOWED_HOSTS, fetch: fetchFn = fetch }: { allowedHosts?: string[]; fetch?: typeof fetch } = {},
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
