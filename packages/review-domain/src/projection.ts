// SPDX-License-Identifier: AGPL-3.0-only
// Projects GitHub-native review content (review comments, threads, review summaries and PR
// conversation comments) into what the review UI shows. Pure: no I/O, no rendering.
//
// App-created comments (bodies carrying annotation metadata) are treated as ordinary native
// comments here; annotation parsing hooks in on `NativeThread.comments` / `ConversationEntry`.
import { ACTIONS_BOT, MARKER } from "@rendered-review/github-action";
import type { Actor, IssueComment, Review, ReviewComment, ReviewThread } from "@rendered-review/github-integration";
import { blocksForLines, type RenderedMarkdown, type SourceNode } from "@rendered-review/markdown-domain";

/** `unknown` when no GraphQL thread data is available (e.g. anonymous public access). */
export type Resolution = "resolved" | "unresolved" | "unknown";

/**
 * Where a native thread applies. GitHub only gives lines, so line anchors are `github-line`:
 * the UI highlights the mapped blocks or line span and must never present a word selection.
 */
export type NativeAnchor =
  | { type: "file" }
  | {
      /** `current`: applies to the PR head (LEFT side: to the base). `outdated`: only to `commitOid`. */
      type: "current" | "outdated";
      kind: "github-line";
      /** RIGHT = lines of the head blob, LEFT = lines of the base blob (deleted lines). */
      side: "LEFT" | "RIGHT";
      /** 1-based inclusive. For `outdated` these are GitHub's original lines. */
      startLine: number;
      endLine: number;
      /** Commit the lines refer to; the original commit when `outdated`. */
      commitOid: string;
    };

export interface NativeThread {
  /** GraphQL thread node id, or `rest:<root comment id>` when grouped from REST reply chains. */
  id: string;
  path: string;
  /** Oldest first; `comments[0]` is the thread root. */
  comments: ReviewComment[];
  resolution: Resolution;
  anchor: NativeAnchor;
}

/** A location taken from a canonical immutable permalink in a conversation comment. Always labeled "inferred". */
export interface InferredLocation {
  kind: "inferred";
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface ConversationEntry {
  comment: IssueComment;
  inferred: InferredLocation[];
}

export interface RepositoryRef {
  /** Web host, `github.com` or a GitHub Enterprise Server host. */
  host: string;
  owner: string;
  name: string;
}

export interface ProjectionInput {
  repository: RepositoryRef;
  reviewComments: ReviewComment[];
  /** GraphQL review threads; omit when unavailable, which makes resolution `unknown`. */
  reviewThreads?: ReviewThread[];
  reviews: Review[];
  issueComments: IssueComment[];
  /** Logins allowed to author the PR-link comment. Defaults to the Actions bot; add the app bot login. */
  integrationBots?: string[];
}

export interface ReviewProjection {
  threads: NativeThread[];
  /** Submitted reviews with a non-empty body, for the PR review-summary area. */
  summaries: Review[];
  /** PR conversation comments minus Rendered Review link comments. */
  conversation: ConversationEntry[];
  /** Threads not known to be resolved, per path. Unknown resolution counts as open. */
  unresolvedByPath: Record<string, number>;
  /** The PR conversation and review events, oldest first. */
  timeline: TimelineItem[];
}

export type TimelineItem =
  | { kind: "comment"; at: string; entry: ConversationEntry }
  /** `threads`: review threads started in this review. */
  | { kind: "review"; at: string; review: Review; threads: NativeThread[] };

export interface ReviewerState {
  author: Actor;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
}

export function projectReview(input: ProjectionInput): ReviewProjection {
  const threads = groupThreads(input.reviewComments, input.reviewThreads);
  const entries = conversation(input.issueComments, input.repository, input.integrationBots);
  return {
    threads,
    summaries: reviewSummaries(input.reviews),
    conversation: entries,
    unresolvedByPath: unresolvedByPath(threads),
    timeline: timeline(entries, input.reviews, threads),
  };
}

const byTime = (a: ReviewComment, b: ReviewComment) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id;

/** Group review comments into threads: GraphQL thread membership when given, else REST reply chains. */
export function groupThreads(comments: ReviewComment[], threads?: ReviewThread[]): NativeThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const claimed = new Set<number>();
  const result: NativeThread[] = [];

  for (const t of threads ?? []) {
    const members = t.commentIds.flatMap((id) => byId.get(id) ?? []);
    if (!members.length) continue;
    members.forEach((c) => claimed.add(c.id));
    result.push(thread(t.nodeId, members.sort(byTime), t.isResolved ? "resolved" : "unresolved"));
  }

  const rootOf = (c: ReviewComment): ReviewComment => {
    const seen = new Set<number>();
    while (c.inReplyToId !== null && byId.has(c.inReplyToId) && !seen.has(c.id)) {
      seen.add(c.id);
      c = byId.get(c.inReplyToId)!;
    }
    return c;
  };
  const chains = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    if (claimed.has(c.id)) continue;
    const root = rootOf(c).id;
    chains.set(root, [...(chains.get(root) ?? []), c]);
  }
  for (const [root, members] of chains) result.push(thread(`rest:${root}`, members.sort(byTime), "unknown"));

  return result.sort((a, b) => byTime(a.comments[0]!, b.comments[0]!));
}

function thread(id: string, comments: ReviewComment[], resolution: Resolution): NativeThread {
  const root = comments[0]!;
  return { id, path: root.path, comments, resolution, anchor: anchor(root) };
}

function anchor(c: ReviewComment): NativeAnchor {
  if (c.subjectType === "file") return { type: "file" };
  const side = c.side ?? "RIGHT";
  // ponytail: a range whose start is on the other diff side spans two blobs; keep only its end line.
  const sameSide = (c.startSide ?? side) === side;
  if (c.line !== null)
    return {
      type: "current",
      kind: "github-line",
      side,
      startLine: (sameSide && c.startLine) || c.line,
      endLine: c.line,
      commitOid: c.commitOid,
    };
  if (c.originalLine !== null)
    return {
      type: "outdated",
      kind: "github-line",
      side,
      startLine: (sameSide && c.originalStartLine) || c.originalLine,
      endLine: c.originalLine,
      commitOid: c.originalCommitOid,
    };
  return { type: "file" };
}

export interface ThreadPlacement {
  thread: NativeThread;
  /** Blocks to highlight; empty for file-scope and outdated threads, or when the side's document is missing. */
  blocks: SourceNode[];
}

/**
 * Place a file's threads on its rendered documents: RIGHT-side lines on the head blob, LEFT-side
 * lines on the base blob. Outdated threads stay unplaced for the historical view. A deleted file
 * has no head: pass only `base`.
 */
export function placeThreads(
  threads: NativeThread[],
  path: string,
  docs: { head?: RenderedMarkdown; base?: RenderedMarkdown },
): ThreadPlacement[] {
  return threads
    .filter((t) => t.path === path)
    .map((thread) => {
      const a = thread.anchor;
      const doc = a.type === "current" ? (a.side === "LEFT" ? docs.base : docs.head) : undefined;
      return { thread, blocks: doc && a.type === "current" ? blocksForLines(doc, a.startLine, a.endLine) : [] };
    });
}

export function reviewSummaries(reviews: Review[]): Review[] {
  return reviews.filter((r) => r.state !== "PENDING" && r.body.trim() !== "");
}

/** The PR-link comment is hidden only when it has the marker AND an expected bot wrote it. */
export function isIntegrationNotice(comment: IssueComment, bots: string[] = [ACTIONS_BOT]): boolean {
  return comment.body.includes(MARKER) && !!comment.author && bots.includes(comment.author.login);
}

export function conversation(comments: IssueComment[], repo: RepositoryRef, bots?: string[]): ConversationEntry[] {
  return comments
    .filter((c) => !isIntegrationNotice(c, bots))
    .map((comment) => ({ comment, inferred: inferLocations(comment.body, repo) }));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Canonical immutable permalinks to this repository: `/blob/<40-hex sha>/<path>#L10` or `#L10-L20`
 * (optionally `?plain=1`, and GitHub's `C<col>` suffixes, which are dropped). Branch links are ignored.
 */
export function inferLocations(body: string, repo: RepositoryRef): InferredLocation[] {
  const re = new RegExp(
    `https://${escapeRe(repo.host)}/([^/\\s]+)/([^/\\s]+)/blob/([0-9a-f]{40})/([^?#\\s)\\]>"']+)(?:\\?plain=1)?#L(\\d+)(?:C\\d+)?(?:-L(\\d+)(?:C\\d+)?)?(?![\\w-])`,
    "gi",
  );
  const out: InferredLocation[] = [];
  for (const [, owner, name, sha, rawPath, from, to] of body.matchAll(re)) {
    if (owner!.toLowerCase() !== repo.owner.toLowerCase() || name!.toLowerCase() !== repo.name.toLowerCase()) continue;
    let path: string;
    try {
      path = decodeURIComponent(rawPath!);
    } catch {
      continue;
    }
    const a = Number(from);
    const b = to ? Number(to) : a;
    out.push({ kind: "inferred", sha: sha!.toLowerCase(), path, startLine: Math.min(a, b), endLine: Math.max(a, b) });
  }
  return out;
}

export function unresolvedByPath(threads: NativeThread[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of threads) if (t.resolution !== "resolved") counts[t.path] = (counts[t.path] ?? 0) + 1;
  return counts;
}

/**
 * Conversation comments and review events, oldest first (comments first on ties). A review
 * shows when it has a body or a verdict; a bodiless "commented" review only carries line
 * comments, and those are read in their documents.
 */
export function timeline(entries: ConversationEntry[], reviews: Review[], threads: NativeThread[]): TimelineItem[] {
  const items: TimelineItem[] = entries.map((entry) => ({ kind: "comment", at: entry.comment.createdAt, entry }));
  for (const review of reviews) {
    if (!review.submittedAt || (review.state === "COMMENTED" && !review.body.trim())) continue;
    const own = threads.filter((t) => t.comments[0]!.reviewId === review.id);
    items.push({ kind: "review", at: review.submittedAt, review, threads: own });
  }
  const rank = (i: TimelineItem) => (i.kind === "comment" ? 0 : 1);
  return items.sort((a, b) => a.at.localeCompare(b.at) || rank(a) - rank(b));
}

/**
 * Each reviewer's current verdict, like GitHub's reviewer list: the latest approval or change
 * request stands until a later one (a dismissal reverts to commented). The PR author is left out.
 */
export function reviewers(reviews: Review[], authorLogin?: string): ReviewerState[] {
  const byLogin = new Map<string, ReviewerState>();
  const submitted = reviews.filter((r) => r.submittedAt && r.author && r.author.login !== authorLogin);
  for (const r of submitted.sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!))) {
    const prev = byLogin.get(r.author!.login)?.state;
    const state =
      r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"
        ? r.state
        : r.state === "DISMISSED"
          ? "COMMENTED"
          : (prev ?? "COMMENTED");
    byLogin.set(r.author!.login, { author: r.author!, state });
  }
  return [...byLogin.values()];
}
