// SPDX-License-Identifier: AGPL-3.0-only
// TanStack Query options for PR data, read with the viewer's access (keys include it). Use with `useQuery`, `useSuspenseQuery` or
// `queryClient.ensureQueryData` in loaders.
import { objectKey } from "@rendered-review/browser-cache";
import type { PullRequest } from "@rendered-review/github-integration";
import { queryOptions } from "@tanstack/react-query";
import type { PrParams } from "../pr-url";
import { type Access, browserCache, userReviewThreads, withGitHub } from "./client";
import { REQUESTED_WITH, TRIAL_ENDS_HEADER, USER_PREFIX } from "./user-proxy";

/** Mutable PR data: refetched (with ETag revalidation) once this old. */
const PR_STALE_MS = 30_000;

/**
 * Stable identity resolved from PR metadata. Names in the URL may be outdated (GitHub redirects
 * renamed repositories); `repositoryId` and `ownerId` are the keys that survive renames.
 */
export interface PrIdentity {
  host: string;
  repositoryId: number;
  ownerId: number;
  /** Current names, as GitHub reports them. */
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  /** Whose access reads this PR's data. */
  access: Access;
}

export const pullRequestQuery = ({ host, owner, repo, number }: PrParams, access: Access) =>
  queryOptions({
    queryKey: ["github", access, host, "pull", owner.toLowerCase(), repo.toLowerCase(), number],
    queryFn: () => withGitHub(access, host, (c) => c.getPullRequest(owner, repo, number)),
    staleTime: PR_STALE_MS,
  });

export function prIdentity(host: string, pr: PullRequest, access: Access): PrIdentity {
  const repository = pr.base.repository;
  // The base repository of a PR exists as long as the PR is visible.
  if (!repository) throw new Error("Pull request has no base repository");
  return {
    host,
    repositoryId: repository.id,
    ownerId: repository.ownerId,
    owner: repository.owner,
    repo: repository.name,
    number: pr.number,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    access,
  };
}

const prKey = (id: PrIdentity, what: string) =>
  ["github", id.access, id.host, id.repositoryId, "pull", id.number, what] as const;

export const changedFilesQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "files"),
    queryFn: () => withGitHub(id.access, id.host, (c) => c.listPullRequestFiles(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

/** The PR's commits, oldest first: titles and dates for its revisions. */
export const pullRequestCommitsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "commits"),
    queryFn: () => withGitHub(id.access, id.host, (c) => c.listPullRequestCommits(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

export const reviewCommentsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "review-comments"),
    queryFn: () => withGitHub(id.access, id.host, (c) => c.listReviewComments(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

export const reviewsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "reviews"),
    queryFn: () => withGitHub(id.access, id.host, (c) => c.listReviews(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

export const issueCommentsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "issue-comments"),
    queryFn: () => withGitHub(id.access, id.host, (c) => c.listIssueComments(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

/** Review-thread resolution. Needs the user's access: GitHub refuses anonymous GraphQL. */
export const reviewThreadsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "review-threads"),
    queryFn: () => userReviewThreads(id.host, id.owner, id.repo, id.number),
    enabled: id.access === "user",
    staleTime: PR_STALE_MS,
  });

/** Immutable content by OID: served from the browser's object store, fetched and stored on a miss. */
async function immutable<T>(id: PrIdentity, key: string, fetchFn: () => Promise<T>): Promise<T> {
  const cacheKey = objectKey(id.host, id.repositoryId, key);
  const hit = await browserCache.get<T>("objects", cacheKey);
  if (hit !== undefined) return hit;
  const value = await fetchFn();
  await browserCache.set("objects", cacheKey, value, { private: id.access === "user" });
  return value;
}

/** Recursive tree at a commit or tree OID (e.g. `id.headSha`). Immutable. */
export const treeQuery = (id: PrIdentity, oid: string) =>
  queryOptions({
    queryKey: ["github", id.access, id.host, id.repositoryId, "tree", oid],
    // Keyed apart from blobs: a commit OID resolves to a tree here, not to the commit object.
    queryFn: () =>
      immutable(id, `tree:${oid}`, () =>
        withGitHub(id.access, id.host, (c) => c.getTree(id.owner, id.repo, oid, { recursive: true })),
      ),
    staleTime: Infinity,
  });

/** Raw text of the file at `path` in commit `commitOid`, without listing the tree. Immutable. */
export const fileAtCommitQuery = (id: PrIdentity, commitOid: string, path: string) =>
  queryOptions({
    queryKey: ["github", id.access, id.host, id.repositoryId, "file", commitOid, path],
    queryFn: () =>
      immutable(id, `file:${commitOid}:${path}`, () =>
        withGitHub(id.access, id.host, (c) => c.getFileContents(id.owner, id.repo, path, commitOid)),
      ),
    staleTime: Infinity,
  });

/** Raw blob text by blob OID. Immutable. */
export const blobQuery = (id: PrIdentity, oid: string) =>
  queryOptions({
    queryKey: ["github", id.access, id.host, id.repositoryId, "blob", oid],
    queryFn: () => immutable(id, oid, () => withGitHub(id.access, id.host, (c) => c.getBlob(id.owner, id.repo, oid))),
    staleTime: Infinity,
  });

/**
 * Whether this deployment offers sign-in and whether the viewer is signed in. Browser only (the
 * server never renders who is signed in); fetched once per page load, since sign-in and sign-out
 * reload the page.
 */
export const viewerQuery = queryOptions({
  queryKey: ["viewer"],
  queryFn: async (): Promise<{ signInEnabled: boolean; signedIn: boolean; login?: string; githubId?: number }> => {
    const res = await fetch("/api/auth/viewer", { cache: "no-store" }).catch(() => undefined);
    if (!res?.ok) return { signInEnabled: false, signedIn: false };
    const user = (await res.json().catch(() => null)) as { login?: string; id?: number } | null;
    return { signInEnabled: true, signedIn: !!user, login: user?.login, githubId: user?.id };
  },
  staleTime: Infinity,
});

/** When the owner's private-repository trial ends (ISO), null outside a trial. Read with the viewer's access. */
export const trialEndsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: ["trial-ends", id.host, id.ownerId],
    queryFn: async () => {
      const path = `repos/${encodeURIComponent(id.owner)}/${encodeURIComponent(id.repo)}`;
      const res = await fetch(`${USER_PREFIX}${id.host}/${path}`, { headers: { "X-Requested-With": REQUESTED_WITH } });
      return res.headers.get(TRIAL_ENDS_HEADER);
    },
    staleTime: Infinity,
  });

/**
 * What an ended trial's refusal names: the repository ID, so the ended page can find the PR's drafts,
 * and the deployment's plans page, when it has one.
 */
export const trialEndedQuery = (host: string, owner: string, repo: string) =>
  queryOptions({
    queryKey: ["trial-ended", host, owner.toLowerCase(), repo.toLowerCase()],
    queryFn: async () => {
      const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const res = await fetch(`${USER_PREFIX}${host}/${path}`, { headers: { "X-Requested-With": REQUESTED_WITH } });
      const body = (await res.json().catch(() => null)) as { repositoryId?: unknown; upgradeUrl?: unknown } | null;
      return {
        repositoryId: Number.isSafeInteger(body?.repositoryId) ? (body!.repositoryId as number) : null,
        upgradeUrl: typeof body?.upgradeUrl === "string" ? body.upgradeUrl : null,
      };
    },
    staleTime: Infinity,
  });
