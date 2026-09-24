// SPDX-License-Identifier: AGPL-3.0-only
// TanStack Query mutations that publish to GitHub through the write boundary (`publish.ts`). Use
// with `useMutation(commentMutation(id))`. Each sends the head the comment was composed against
// and, on success, refreshes the PR data it changed. Failures are `PublishError`s.
import type { IssueComment, ReviewComment } from "@rendered-review/github-integration";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { authorizePublicComments } from "../ui/Viewer";
import { type PublishErrorCode, WRITE_PREFIX } from "./publish";
import { issueCommentsQuery, type PrIdentity, reviewCommentsQuery, reviewsQuery, reviewThreadsQuery } from "./queries";
import { REQUESTED_WITH } from "./user-proxy";

type Side = "LEFT" | "RIGHT";
export type CommentInput = { body: string } & (
  | { representation: "review-line"; path: string; line: number; side: Side; startLine?: number; startSide?: Side }
  | { representation: "review-file"; path: string }
  | { representation: "conversation" }
);

export interface ReviewInput {
  /** Reuse it when sending the same submission again: the server publishes it only once. */
  submissionId: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  /** The review summary. */
  body?: string;
  drafts: (CommentInput & { id: string })[];
}

type ErrorBody = {
  code: PublishErrorCode;
  message: string;
  retryAs?: "review-file";
  headOid?: string;
  resetAt?: string;
};

export interface ReviewResult {
  /** False when anything failed; `results` says what. */
  ok: boolean;
  /** The native review, when there was one to submit. */
  review?: { ok: true; reviewId: number } | { ok: false; error: ErrorBody };
  results: ({ draftId: string } & (
    { ok: true; reviewId?: number; commentId?: number; url?: string } | { ok: false; error: ErrorBody }
  ))[];
}

export class PublishError extends Error {
  readonly code: PublishErrorCode;
  /** GitHub refused a native line location: publishing as a file comment should work. */
  readonly retryAs?: "review-file";
  /** `stale-head`: the PR's current head. */
  readonly headOid?: string;
  /** `rate-limited`: when to try again (ISO time). */
  readonly resetAt?: string;
  /** The review draft that was refused. */
  readonly draftId?: string;

  constructor(
    readonly status: number,
    body: ErrorBody & { draftId?: string },
  ) {
    super(body.message);
    this.name = "PublishError";
    Object.assign(this, body);
    this.code = body.code;
  }
}

async function send<T>(id: PrIdentity, operation: string, payload: object): Promise<T> {
  const url = `${WRITE_PREFIX}${id.host}/${encodeURIComponent(id.owner)}/${encodeURIComponent(id.repo)}/pulls/${id.number}/${operation}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": REQUESTED_WITH },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (res.ok) return body as T;
  throw new PublishError(
    res.status,
    (body as ErrorBody | undefined)?.code
      ? (body as ErrorBody)
      : { code: "github-error", message: `Publishing failed (${res.status})` },
  );
}

type What = "review-comments" | "review-threads" | "reviews" | "issue-comments";
const QUERIES = {
  "review-comments": reviewCommentsQuery,
  "review-threads": reviewThreadsQuery,
  reviews: reviewsQuery,
  "issue-comments": issueCommentsQuery,
};

const refresh = (client: QueryClient, id: PrIdentity, what: What[]) =>
  Promise.all(what.map((w) => client.invalidateQueries({ queryKey: QUERIES[w](id).queryKey })));

function onError(error: Error, client: QueryClient, id: PrIdentity) {
  if (!(error instanceof PublishError)) return;
  if (error.code === "needs-public-authorization") return authorizePublicComments();
  // Every PR metadata query for the host: the URL's names may differ from the current ones.
  if (error.code === "stale-head")
    return client.invalidateQueries({ queryKey: ["github", id.access, id.host, "pull"] });
}

const publishing = <T, V>(id: PrIdentity, operation: string, payload: (v: V) => object, changes: (v: V) => What[]) =>
  mutationOptions<T, Error, V>({
    mutationKey: ["publish", id.host, id.repositoryId, id.number, operation],
    mutationFn: (v) => send<T>(id, operation, payload(v)),
    onSuccess: (_data, v, _result, { client }) => refresh(client, id, changes(v)),
    onError: (error, _v, _result, { client }) => onError(error, client, id),
  });

/** A new comment: native line or file review comment, or PR conversation comment (app threads, replies and resolutions included). */
export const commentMutation = (id: PrIdentity) =>
  publishing<{ comment: ReviewComment | IssueComment }, CommentInput>(
    id,
    "comment",
    (v) => ({ expectedHeadOid: id.headSha, ...v }),
    (v) => (v.representation === "conversation" ? ["issue-comments"] : ["review-comments", "review-threads"]),
  );

/** A reply in a native review thread; `inReplyTo` is the thread's first comment. */
export const replyMutation = (id: PrIdentity) =>
  publishing<{ comment: ReviewComment }, { inReplyTo: number; body: string }>(
    id,
    "reply",
    (v) => ({ expectedHeadOid: id.headSha, ...v }),
    () => ["review-comments", "review-threads"],
  );

/** Resolves or reopens a native review thread. */
export const resolveMutation = (id: PrIdentity) =>
  publishing<{ thread: { nodeId: string; isResolved: boolean } }, { threadNodeId: string; resolved: boolean }>(
    id,
    "resolve",
    (v) => v,
    () => ["review-threads"],
  );

/** Submits drafts (and an optional summary) as a review. Resolves with per-draft results, even on partial failure. */
export const reviewMutation = (id: PrIdentity) =>
  publishing<ReviewResult, ReviewInput>(
    id,
    "review",
    (v) => ({ expectedHeadOid: id.headSha, ...v }),
    () => ["reviews", "review-comments", "review-threads", "issue-comments"],
  );
