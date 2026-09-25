// SPDX-License-Identifier: AGPL-3.0-only
// Signed-in GitHub reads: the same strict path allowlist as the public proxy, read with the
// user's own token (their access and rate limit). Responses are per user, so never
// shared-cacheable. Private repositories only where the deployment's entitlement check allows them
// (never in community mode). Web Request/Response/fetch only.
import { createGitHubClient, GitHubError } from "@rendered-review/github-integration";
import type { Identity } from "@rendered-review/identity";
import { log } from "@rendered-review/runtime";
import type { EntitlementCheck } from "../billing";
import { forRepository, privateAccess } from "./broker";
import { meteredFetch } from "./metrics";
import {
  ACCEPT,
  apiBase,
  classifyPath,
  forwardHeaders,
  parseProxyPath,
  REPO_PREFIX,
  REPO_SEGMENT,
  reject,
  repoFacts,
} from "./proxy";

export const USER_PREFIX = "/api/github/user/";
/** Browsers only send it from same-origin script, so a cross-site page cannot trigger reads. */
export const REQUESTED_WITH = "rendered-review";
/** Body of the 403 for a private repository; the client matches on it. */
export const PRIVATE_REPO_UNSUPPORTED = "Private repositories aren't supported yet";
/** Body of the 403 for a private repository no plan or policy covers. */
export const NOT_ENTITLED = "This private repository isn't covered by a Rendered Review plan";
/** Body of the 403 once the owner's private-repository trial has ended; the client matches on it. */
export const TRIAL_EXPIRED = "The private-repository trial for this owner has ended";
/** Where an ended trial points. ponytail: a placeholder path until billing has its own pages. */
export const UPGRADE_URL = "/pricing";
/** On private reads covered by a trial: when it ends (ISO), for the days-left indicator. */
export const TRIAL_ENDS_HEADER = "x-rendered-review-trial-ends";

// Largest response passed through; GitHub's own pages are far smaller, blobs can be huge.
const MAX_BYTES = 10 * 1024 * 1024;
// The one GraphQL operation: the server builds the query; the path supplies validated variables.
const REVIEW_THREADS = new RegExp(
  String.raw`^repos/(${REPO_SEGMENT})/(${REPO_SEGMENT})/pulls/(\d{1,10})/review-threads$`,
);
const PRIVATE = { "cache-control": "private, no-store", vary: "Cookie" };

const deny = (status: number, category: string, message: string) => {
  log.info("github.user_proxy", { category, status });
  const res = reject(status, message, category);
  res.headers.set("vary", "Cookie");
  return res;
};
const reauth = () => deny(401, "reauth", "Sign in with GitHub again");
const notEntitled = (reason: string) => {
  const ended = reason === "trial-expired";
  log.info("github.user_proxy", { category: ended ? reason : "not-entitled", status: 403 });
  return Response.json(
    ended
      ? { code: reason, message: TRIAL_EXPIRED, upgradeUrl: UPGRADE_URL }
      : { message: NOT_ENTITLED, code: "not-entitled", reason },
    { status: 403, headers: { "cache-control": "no-store", vary: "Cookie" } },
  );
};

export async function proxyUserGitHub(
  request: Request,
  {
    allowedHosts,
    identity,
    fetch: unmetered = fetch,
    entitlement,
  }: {
    allowedHosts: string[];
    /** Undefined when this deployment has no sign-in. */
    identity: Pick<Identity, "getSessionUser" | "getUserGitHubToken"> | undefined;
    fetch?: typeof fetch;
    /** Undefined in community mode: private repositories are then refused. */
    entitlement?: EntitlementCheck;
  },
): Promise<Response> {
  if (request.method !== "GET") return reject(405, "Method not allowed");
  if (request.headers.get("x-requested-with") !== REQUESTED_WITH) return reject(403, "Missing X-Requested-With");
  if (!identity) return reject(404, "Not found");
  const fetchFn = meteredFetch(unmetered);
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
  // The repository-authorization seam: a private repository is served only when the entitlement
  // check (local access policy, installation and, when hosted, the owner's plan) allows it.
  const repoPath = REPO_PREFIX.exec(path)![0];
  const facts = await repoFacts(host, repoPath, headers, fetchFn, !entitlement);
  if (facts instanceof Response) return facts.status === 401 ? reauth() : passError(facts);
  let served: Record<string, string> = PRIVATE;
  if (facts.visibility === "private") {
    const [, , name] = repoPath.split("/");
    const decision = await privateAccess(host, repoPath.startsWith("repos/") ? name : undefined, facts, entitlement, {
      userId: user.id,
      operation: "read",
    });
    if (!decision) return deny(403, "private-repo-unsupported", PRIVATE_REPO_UNSUPPORTED);
    if (!decision.allowed) return notEntitled(decision.reason);
    if (decision.reason === "trial" && decision.validUntil)
      served = { ...PRIVATE, [TRIAL_ENDS_HEADER]: decision.validUntil };
  }

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
      return Response.json(await client.listReviewThreads(owner!, repo!, Number(number)), { headers: served });
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
  return new Response(body, { status: upstream.status, headers: forwardHeaders(upstream, served) });
}

async function passError(upstream: Response): Promise<Response> {
  return new Response(await upstream.text(), { status: upstream.status, headers: forwardHeaders(upstream, PRIVATE) });
}
