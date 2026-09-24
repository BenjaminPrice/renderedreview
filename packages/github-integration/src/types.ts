// SPDX-License-Identifier: AGPL-3.0-only
// Normalized GitHub response types and the mappers that produce them from REST/GraphQL payloads.
// Timestamps stay ISO-8601 strings so values survive JSON and IndexedDB round-trips unchanged.

/** A GitHub account. `null` where GitHub reports a deleted ("ghost") user. */
export interface Actor {
  login: string;
  id: number;
  nodeId: string;
  /** "User", "Bot", "Organization" or "Mannequin". */
  type: string;
}

export interface Repository {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  /** Present only on authenticated requests. */
  permissions?: { admin: boolean; maintain?: boolean; push: boolean; triage?: boolean; pull: boolean };
}

export interface PullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  htmlUrl: string;
  author: Actor | null;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  changedFiles: number;
  head: { ref: string; sha: string; repository: Repository | null };
  base: { ref: string; sha: string; repository: Repository | null };
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  /** Blob OID of the file at the PR head. */
  blobOid: string;
  additions: number;
  deletions: number;
  changes: number;
  /** Absent for binary or very large diffs. */
  patch?: string;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  size?: number;
}

export interface Tree {
  oid: string;
  /** True when GitHub cut the listing short (recursive trees over its limits). */
  truncated: boolean;
  entries: TreeEntry[];
}

export interface ReviewComment {
  id: number;
  nodeId: string;
  reviewId: number | null;
  inReplyToId: number | null;
  path: string;
  commitOid: string;
  originalCommitOid: string;
  /** `null` when the comment is outdated or file-level. */
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  side: "LEFT" | "RIGHT" | null;
  startSide: "LEFT" | "RIGHT" | null;
  subjectType: "line" | "file";
  diffHunk: string;
  body: string;
  author: Actor | null;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface Review {
  id: number;
  nodeId: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  commitOid: string | null;
  /** `null` for pending reviews. */
  submittedAt: string | null;
  author: Actor | null;
  authorAssociation: string;
  htmlUrl: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  author: Actor | null;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/** Resolution state of a native review thread; join to {@link ReviewComment} via `commentIds`. */
export interface ReviewThread {
  nodeId: string;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: string | null;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  subjectType: "LINE" | "FILE";
  /** REST ids of the thread's comments, oldest first. */
  commentIds: number[];
}

// Raw GitHub payloads are only read here; their full shapes are not worth mirroring.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Raw = any;

const actor = (u: Raw): Actor | null => u && { login: u.login, id: u.id, nodeId: u.node_id, type: u.type };

const repository = (r: Raw): Repository | null =>
  r && {
    id: r.id,
    nodeId: r.node_id,
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    ...(r.permissions && { permissions: r.permissions }),
  };

export const toPullRequest = (p: Raw): PullRequest => ({
  id: p.id,
  nodeId: p.node_id,
  number: p.number,
  title: p.title,
  body: p.body,
  state: p.state,
  draft: p.draft ?? false,
  merged: p.merged_at != null,
  htmlUrl: p.html_url,
  author: actor(p.user),
  authorAssociation: p.author_association,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
  closedAt: p.closed_at,
  mergedAt: p.merged_at,
  changedFiles: p.changed_files,
  head: { ref: p.head.ref, sha: p.head.sha, repository: repository(p.head.repo) },
  base: { ref: p.base.ref, sha: p.base.sha, repository: repository(p.base.repo) },
});

export const toChangedFile = (f: Raw): ChangedFile => ({
  path: f.filename,
  ...(f.previous_filename && { previousPath: f.previous_filename }),
  status: f.status,
  blobOid: f.sha,
  additions: f.additions,
  deletions: f.deletions,
  changes: f.changes,
  ...(f.patch !== undefined && { patch: f.patch }),
});

export const toTree = (t: Raw): Tree => ({
  oid: t.sha,
  truncated: t.truncated,
  entries: t.tree.map((e: Raw) => ({
    path: e.path,
    mode: e.mode,
    type: e.type,
    oid: e.sha,
    ...(e.size !== undefined && { size: e.size }),
  })),
});

export const toReviewComment = (c: Raw): ReviewComment => ({
  id: c.id,
  nodeId: c.node_id,
  reviewId: c.pull_request_review_id ?? null,
  inReplyToId: c.in_reply_to_id ?? null,
  path: c.path,
  commitOid: c.commit_id,
  originalCommitOid: c.original_commit_id,
  line: c.line ?? null,
  originalLine: c.original_line ?? null,
  startLine: c.start_line ?? null,
  originalStartLine: c.original_start_line ?? null,
  side: c.side ?? null,
  startSide: c.start_side ?? null,
  subjectType: c.subject_type ?? "line",
  diffHunk: c.diff_hunk,
  body: c.body,
  author: actor(c.user),
  authorAssociation: c.author_association,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  htmlUrl: c.html_url,
});

export const toReview = (r: Raw): Review => ({
  id: r.id,
  nodeId: r.node_id,
  state: r.state,
  body: r.body ?? "",
  commitOid: r.commit_id ?? null,
  submittedAt: r.submitted_at ?? null,
  author: actor(r.user),
  authorAssociation: r.author_association,
  htmlUrl: r.html_url,
});

export const toIssueComment = (c: Raw): IssueComment => ({
  id: c.id,
  nodeId: c.node_id,
  body: c.body ?? "",
  author: actor(c.user),
  authorAssociation: c.author_association,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  htmlUrl: c.html_url,
});

export const toReviewThread = (t: Raw): ReviewThread => ({
  nodeId: t.id,
  isResolved: t.isResolved,
  isOutdated: t.isOutdated,
  resolvedBy: t.resolvedBy?.login ?? null,
  path: t.path,
  line: t.line,
  originalLine: t.originalLine,
  startLine: t.startLine,
  originalStartLine: t.originalStartLine,
  diffSide: t.diffSide,
  subjectType: t.subjectType,
  commentIds: t.comments.nodes.map((c: Raw) => c.databaseId),
});
