// SPDX-License-Identifier: AGPL-3.0-only
// Builders for review-content component tests.
import type { ReviewComment } from "@rendered-review/github-integration";
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
