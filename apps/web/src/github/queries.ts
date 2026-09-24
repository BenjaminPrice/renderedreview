// SPDX-License-Identifier: AGPL-3.0-only
// TanStack Query options for public PR data. Use with `useQuery`, `useSuspenseQuery` or
// `queryClient.ensureQueryData` in loaders.
import { objectKey } from "@rendered-review/browser-cache";
import type { PullRequest } from "@rendered-review/github-integration";
import { queryOptions } from "@tanstack/react-query";
import type { PrParams } from "../pr-url";
import { browserCache, withPublicGitHub } from "./client";

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
}

export const pullRequestQuery = ({ host, owner, repo, number }: PrParams) =>
  queryOptions({
    queryKey: ["github", host, "pull", owner.toLowerCase(), repo.toLowerCase(), number],
    queryFn: () => withPublicGitHub(host, (c) => c.getPullRequest(owner, repo, number)),
    staleTime: PR_STALE_MS,
  });

export function prIdentity(host: string, pr: PullRequest): PrIdentity {
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
  };
}

const prKey = (id: PrIdentity, what: string) => ["github", id.host, id.repositoryId, "pull", id.number, what] as const;

export const changedFilesQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "files"),
    queryFn: () => withPublicGitHub(id.host, (c) => c.listPullRequestFiles(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

export const reviewCommentsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "review-comments"),
    queryFn: () => withPublicGitHub(id.host, (c) => c.listReviewComments(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

export const reviewsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "reviews"),
    queryFn: () => withPublicGitHub(id.host, (c) => c.listReviews(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

export const issueCommentsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "issue-comments"),
    queryFn: () => withPublicGitHub(id.host, (c) => c.listIssueComments(id.owner, id.repo, id.number)),
    staleTime: PR_STALE_MS,
  });

/**
 * Review-thread resolution, or `null` when GitHub won't say: GraphQL rejects anonymous calls
 * (401). Resolution is then unknown; a failure here never fails the page.
 */
export const reviewThreadsQuery = (id: PrIdentity) =>
  queryOptions({
    queryKey: prKey(id, "review-threads"),
    queryFn: () =>
      withPublicGitHub(id.host, (c) => c.listReviewThreads(id.owner, id.repo, id.number)).catch(() => null),
    // Don't keep asking once refused.
    staleTime: (query) => (query.state.data === null ? Infinity : PR_STALE_MS),
  });

/** Immutable content by OID: served from the browser's object store, fetched and stored on a miss. */
async function immutable<T>(id: PrIdentity, key: string, fetchFn: () => Promise<T>): Promise<T> {
  const cacheKey = objectKey(id.host, id.repositoryId, key);
  const hit = await browserCache.get<T>("objects", cacheKey);
  if (hit !== undefined) return hit;
  const value = await fetchFn();
  await browserCache.set("objects", cacheKey, value, { private: false });
  return value;
}

/** Recursive tree at a commit or tree OID (e.g. `id.headSha`). Immutable. */
export const treeQuery = (id: PrIdentity, oid: string) =>
  queryOptions({
    queryKey: ["github", id.host, id.repositoryId, "tree", oid],
    // Keyed apart from blobs: a commit OID resolves to a tree here, not to the commit object.
    queryFn: () =>
      immutable(id, `tree:${oid}`, () =>
        withPublicGitHub(id.host, (c) => c.getTree(id.owner, id.repo, oid, { recursive: true })),
      ),
    staleTime: Infinity,
  });

/** Raw blob text by blob OID. Immutable. */
export const blobQuery = (id: PrIdentity, oid: string) =>
  queryOptions({
    queryKey: ["github", id.host, id.repositoryId, "blob", oid],
    queryFn: () => immutable(id, oid, () => withPublicGitHub(id.host, (c) => c.getBlob(id.owner, id.repo, oid))),
    staleTime: Infinity,
  });
