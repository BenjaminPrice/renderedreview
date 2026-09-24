// SPDX-License-Identifier: AGPL-3.0-only
// Builders for review-domain tests.
import type { RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import type { Actor, IssueComment, ReviewComment } from "@rendered-review/github-integration";
import type { CommentContext } from "./classify.js";

export const HEAD = "a".repeat(40);
export const BLOB = "c".repeat(40);
export const OLD_BLOB = "d".repeat(40);

export const context: CommentContext = {
  host: "github.com",
  owner: "acme",
  name: "docs",
  repositoryId: 42,
  pullRequest: 7,
};

export const user = (login: string, type = "User"): Actor => ({ login, id: 1, nodeId: "U", type });

/** `The system retries failed requests indefinitely.` is line 3 of {@link DOC}; this quotes words 3–5. */
export const DOC = "# Reliability\n\nThe system retries failed requests indefinitely.\n";

export function annotation(over: Partial<RenderedReviewAnnotationV1> = {}): RenderedReviewAnnotationV1 {
  return {
    version: 1,
    target: {
      githubHost: "github.com",
      repositoryId: 42,
      repository: "acme/docs",
      pullRequest: 7,
      path: "doc.md",
      commitOid: HEAD,
      blobOid: BLOB,
      selectors: [
        {
          type: "TextQuoteSelector",
          exact: "retries failed requests",
          prefix: "The system ",
          suffix: " indefinitely.",
        },
        { type: "TextPositionSelector", start: 26, end: 49 },
        { type: "MarkdownSourceRangeSelector", startLine: 3, startColumn: 12, endLine: 3, endColumn: 35 },
      ],
    },
    motivation: "commenting",
    createdBy: "rendered-review",
    ...over,
  };
}

export const target = (over: Partial<RenderedReviewAnnotationV1["target"]>) => {
  const a = annotation();
  return { ...a, target: { ...a.target, ...over } };
};

let seq = 1000;
export const at = (second: number) =>
  `2026-01-01T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;

export const issueComment = (body: string, over: Partial<IssueComment> = {}): IssueComment => {
  const id = ++seq;
  return {
    id,
    nodeId: `IC${id}`,
    body,
    author: user("alice"),
    authorAssociation: "MEMBER",
    createdAt: at(id % 3000),
    updatedAt: at(id % 3000),
    htmlUrl: `https://github.com/acme/docs/pull/7#issuecomment-${id}`,
    ...over,
  };
};

export const reviewComment = (body: string, over: Partial<ReviewComment> = {}): ReviewComment => {
  const id = ++seq;
  return {
    id,
    nodeId: `RC${id}`,
    reviewId: 1,
    inReplyToId: null,
    path: "doc.md",
    commitOid: HEAD,
    originalCommitOid: HEAD,
    line: 3,
    originalLine: 3,
    startLine: null,
    originalStartLine: null,
    side: "RIGHT",
    startSide: null,
    subjectType: "line",
    diffHunk: "",
    body,
    author: user("alice"),
    authorAssociation: "MEMBER",
    createdAt: at(id % 3000),
    updatedAt: at(id % 3000),
    htmlUrl: `https://github.com/acme/docs/pull/7#discussion_r${id}`,
    ...over,
  };
};
