// SPDX-License-Identifier: AGPL-3.0-only
// Builders for review-content component tests.
import type { IssueComment, ReviewComment } from "@rendered-review/github-integration";
import type { NativeAnchor, NativeThread, RepositoryRef, Resolution } from "@rendered-review/review-domain";

export const repository: RepositoryRef = { host: "github.com", owner: "acme", name: "docs" };
export const HEAD = "abc1234def5678abc1234def5678abc1234def56";
export const OLD = "0ff1ce0ff1ce0ff1ce0ff1ce0ff1ce0ff1ce0ff1";

let nextId = 1;

export function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  const id = nextId++;
  return {
    id,
    nodeId: `C${id}`,
    reviewId: null,
    inReplyToId: null,
    path: "docs/guide.md",
    commitOid: HEAD,
    originalCommitOid: HEAD,
    line: 3,
    originalLine: 3,
    startLine: null,
    originalStartLine: null,
    side: "RIGHT",
    startSide: null,
    subjectType: "line",
    diffHunk: "@@ -1,3 +1,3 @@\n one\n two\n+three",
    body: "Looks good.",
    author: { login: "alice", id: 1, nodeId: "U1", type: "User" },
    authorAssociation: "MEMBER",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    htmlUrl: `https://github.com/acme/docs/pull/7#discussion_r${id}`,
    ...over,
  };
}

export const lineAnchor = (
  startLine: number,
  endLine = startLine,
  type: "current" | "outdated" = "current",
  commitOid = HEAD,
): NativeAnchor => ({ type, kind: "github-line", side: "RIGHT", startLine, endLine, commitOid });

export function thread(
  id: string,
  anchor: NativeAnchor,
  resolution: Resolution = "unknown",
  comments: ReviewComment[] = [comment()],
): NativeThread {
  return { id, path: "docs/guide.md", comments, resolution, anchor };
}

type Annotation = Extract<NativeAnchor, { type: "annotation" }>["annotation"];

/** An annotation on the words "retries failed requests" (line 3) of docs/guide.md at {@link HEAD}. */
export const annotation = (over: Partial<Annotation> = {}): Annotation => ({
  version: 1,
  target: {
    githubHost: "github.com",
    repositoryId: 42,
    repository: "acme/docs",
    pullRequest: 7,
    path: "docs/guide.md",
    commitOid: HEAD,
    blobOid: OLD,
    selectors: [
      { type: "TextQuoteSelector", exact: "retries failed requests" },
      { type: "TextPositionSelector", start: 11, end: 34 },
      { type: "MarkdownSourceRangeSelector", startLine: 3, startColumn: 12, endLine: 3, endColumn: 35 },
    ],
  },
  motivation: "commenting",
  ...over,
});

/** A PR conversation comment as Rendered Review writes it (quote, comment, permalink, marker). */
export function issueComment(text: string, over: Partial<IssueComment> = {}): IssueComment {
  const id = nextId++;
  return {
    id,
    nodeId: `IC${id}`,
    body: [
      "> retries failed requests",
      text,
      `Document: [\`docs/guide.md\`](https://github.com/acme/docs/blob/${HEAD}/docs/guide.md?plain=1#L3-L3)`,
      "<!-- rendered-review:v1:e30= -->",
    ].join("\n\n"),
    author: { login: "alice", id: 1, nodeId: "U1", type: "User" },
    authorAssociation: "MEMBER",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    htmlUrl: `https://github.com/acme/docs/pull/7#issuecomment-${id}`,
    ...over,
  };
}

/** An application thread whose comments all carry the same valid annotation. */
export function appThread(
  comments: IssueComment[] = [issueComment("Needs a retry limit.")],
  over: Partial<NativeThread> = {},
): NativeThread {
  const a = annotation();
  return {
    id: `app:${comments[0]!.id}`,
    path: "docs/guide.md",
    comments,
    resolution: "unresolved",
    anchor: { type: "annotation", annotation: a },
    metadata: Object.fromEntries(comments.map((c) => [c.id, { state: "valid", annotation: a, edited: false }])),
    ...over,
  };
}
