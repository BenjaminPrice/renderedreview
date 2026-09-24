// SPDX-License-Identifier: AGPL-3.0-only
// Signed-in GitHub reads: the same strict path allowlist as the public proxy, read with the
// user's own token (their access and rate limit). Responses are per user, so never
// shared-cacheable. Public repositories only for now. Web Request/Response/fetch only.
import { createGitHubClient, GitHubError } from "@rendered-review/github-integration";
import type { Identity } from "@rendered-review/identity";
import { forRepository } from "./broker";
import {
  ACCEPT,
  apiBase,
  classifyPath,
  forwardHeaders,
  parseProxyPath,
  REPO_PREFIX,
  REPO_SEGMENT,
  reject,
  repoVisibility,
} from "./proxy";

export const USER_PREFIX = "/api/github/user/";
/** Browsers only send it from same-origin script, so a cross-site page cannot trigger reads. */
export const REQUESTED_WITH = "rendered-review";
/** Body of the 403 for a private repository; the client matches on it. */
export const PRIVATE_REPO_UNSUPPORTED = "Private repositories aren't supported yet";

// Largest response passed through; GitHub's own pages are far smaller, blobs can be huge.
const MAX_BYTES = 10 * 1024 * 1024;
// The one GraphQL operation: the server builds the query; the path supplies validated variables.
const REVIEW_THREADS = new RegExp(
  String.raw`^repos/(${REPO_SEGMENT})/(${REPO_SEGMENT})/pulls/(\d{1,10})/review-threads$`,
);
const PRIVATE = { "cache-control": "private, no-store", vary: "Cookie" };

const deny = (status: number, category: string, message: string) => {
  console.info(`github user read: ${category}`);
  const res = reject(status, message, category);
  res.headers.set("vary", "Cookie");
  return res;
};
const reauth = () => deny(401, "reauth", "Sign in with GitHub again");

export async function proxyUserGitHub(
  request: Request,
  {
    allowedHosts,
    identity,
    fetch: fetchFn = fetch,
  }: {
    allowedHosts: string[];
    /** Undefined when this deployment has no sign-in. */
    identity: Pick<Identity, "getSessionUser" | "getUserGitHubToken"> | undefined;
    fetch?: typeof fetch;
  },
): Promise<Response> {
  if (request.method !== "GET") return reject(405, "Method not allowed");
  if (request.headers.get("x-requested-with") !== REQUESTED_WITH) return reject(403, "Missing X-Requested-With");
  if (!identity) return reject(404, "Not found");
  const url = new URL(request.url);
  const target = parseProxyPath(url, USER_PREFIX, allowedHosts);
  if (target instanceof Response) return target;
  const { host } = target;
  const threads = url.search ? null : REVIEW_THREADS.exec(target.path);
  // Forward the canonical path, exactly what was validated.
  const path = threads ? target.path : classifyPath(target.path, url.searchParams)?.path;
  if (!path) return reject(403, "Path not allowed");

  const user = await identity.getSessionUser(request.headers);
  if (!user) return deny(401, "unauthenticated", "Sign in with GitHub");
  const credential = await forRepository(
    { userId: user.id, host, owner: "", repo: "", operation: "read" },
    { identity },
  );
  if (credential.kind !== "user") return reauth();

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rendered-review",
    Authorization: `Bearer ${credential.token}`,
  };
  // The repository-authorization seam: private repositories need an installation and entitlement
  // check before they can be served; until then they are refused.
  const visibility = await repoVisibility(host, REPO_PREFIX.exec(path)![0], headers, fetchFn);
  if (visibility === "private") return deny(403, "private-repo-unsupported", PRIVATE_REPO_UNSUPPORTED);
  if (visibility instanceof Response) return visibility.status === 401 ? reauth() : passError(visibility);

  if (threads) {
    const [, owner, repo, number] = threads;
    // ponytail: every page of threads in one response; cap pages if a PR ever has thousands.
    const client = createGitHubClient({
      host,
      fetch: fetchFn,
      auth: () => headers.Authorization,
      maxRetries: 0,
    });
    try {
      return Response.json(await client.listReviewThreads(owner!, repo!, Number(number)), { headers: PRIVATE });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (error.status === 401) return reauth();
      return deny(error.status || 502, "graphql-error", "GitHub request failed");
    }
  }

  const accept = request.headers.get("accept") ?? "";
  if (ACCEPT.has(accept)) headers.Accept = accept;
  const etag = request.headers.get("if-none-match");
  if (etag) headers["If-None-Match"] = etag;
  const upstream = await fetchFn(`${apiBase(host)}/${path}${url.search}`, { headers });
  if (upstream.status === 401) return reauth();
  if (Number(upstream.headers.get("content-length")) > MAX_BYTES) return deny(502, "too-large", "Response too large");
  const body = upstream.status === 304 ? null : await upstream.arrayBuffer();
  if (body && body.byteLength > MAX_BYTES) return deny(502, "too-large", "Response too large");
  return new Response(body, { status: upstream.status, headers: forwardHeaders(upstream, PRIVATE) });
}

async function passError(upstream: Response): Promise<Response> {
  return new Response(await upstream.text(), { status: upstream.status, headers: forwardHeaders(upstream, PRIVATE) });
}
