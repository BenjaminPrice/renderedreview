// SPDX-License-Identifier: AGPL-3.0-only
// Projects GitHub-native review content (review comments, threads, review summaries and PR
// conversation comments) into what the review UI shows. Pure: no I/O, no rendering.
//
// Application comments stored as PR conversation comments are rebuilt into threads (./threads.ts)
// and classified by their annotation metadata (./classify.ts).
import {
  type RenderedReviewAnnotationV1,
  stripRedundantContext,
  verifyContent,
} from "@rendered-review/annotation-domain";
import { ACTIONS_BOT, MARKER } from "@rendered-review/github-action";
import type { Actor, IssueComment, Review, ReviewComment, ReviewThread } from "@rendered-review/github-integration";
import { blocksForLines, type RenderedMarkdown, type SourceNode } from "@rendered-review/markdown-domain";
import { type Classification, classifyComment, type CommentContext } from "./classify.js";
import { reanchor, type ReanchorResult } from "./reanchor.js";
import { reconstructThreads } from "./threads.js";

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
    }
  | {
      /**
       * Exact words from a validated annotation, on the blob it names. Placed only after the
       * blob's content matches (`placeThreads`); otherwise `fallback` (a review comment's own
       * GitHub location) is used, if any.
       */
      type: "annotation";
      annotation: RenderedReviewAnnotationV1;
      fallback?: NativeAnchor;
    };

/** A PR comment in a thread: native review comments, or conversation comments in application threads. */
export type ThreadComment = ReviewComment | IssueComment;

/** Resolve or reopen of an application thread: a visible PR conversation comment with `resolving` metadata. */
export interface ResolutionEvent {
  resolution: "resolved" | "reopened";
  at: string;
  comment: IssueComment;
}

/** A native review thread, or an application thread rebuilt from PR conversation comments. */
export interface NativeThread {
  /**
   * GraphQL thread node id, `rest:<root comment id>` when grouped from REST reply chains, or
   * `app:<root comment id>` for application threads.
   */
  id: string;
  path: string;
  /** Oldest first; `comments[0]` is the thread root. */
  comments: ThreadComment[];
  resolution: Resolution;
  anchor: NativeAnchor;
  /** Annotation classification of comments that carry metadata, by comment id. */
  metadata?: Record<number, Classification>;
  /** Application threads: resolve/reopen events, oldest first. They are not comments. */
  events?: ResolutionEvent[];
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
  /** Annotation classification when the comment carries metadata that is not used for a thread. */
  metadata?: Classification;
}

export interface RepositoryRef {
  /** Web host, `github.com` or a GitHub Enterprise Server host. */
  host: string;
  owner: string;
  name: string;
}

export interface ProjectionInput {
  /** The pull request the comments were loaded from; annotations must name exactly this. */
  repository: CommentContext;
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
  /** PR conversation comments minus Rendered Review link comments and application threads. */
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
  const context = input.repository;
  const native = groupThreads(input.reviewComments, input.reviewThreads).map((t) => annotateThread(t, context));
  const visible = input.issueComments.filter((c) => !isIntegrationNotice(c, input.integrationBots));
  const app = reconstructThreads(visible, context);
  const threads = [...native, ...app.threads].sort((a, b) => byTime(a.comments[0]!, b.comments[0]!));
  const entries = app.rest.map(({ comment, classification }): ConversationEntry => ({
    comment,
    inferred: inferLocations(comment.body, context),
    ...(classification.state !== "native" && { metadata: classification }),
  }));
  return {
    threads,
    summaries: reviewSummaries(input.reviews),
    conversation: entries,
    unresolvedByPath: unresolvedByPath(threads),
    timeline: timeline(entries, input.reviews, threads),
  };
}

const byTime = (a: { createdAt: string; id: number }, b: { createdAt: string; id: number }) =>
  a.createdAt.localeCompare(b.createdAt) || a.id - b.id;

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

/** First and last line (inclusive) an anchor covers; `undefined` at file scope. */
export function anchorLines(a: NativeAnchor): { startLine: number; endLine: number } | undefined {
  if (a.type === "file") return undefined;
  if (a.type !== "annotation") return { startLine: a.startLine, endLine: a.endLine };
  return rangeLines(sourceRange(a.annotation));
}

/** First and last line (inclusive) of a half-open source range: ending at column 1 excludes that line. */
export const rangeLines = (r: AnnotationRange["sourceRange"]) => ({
  startLine: r.startLine,
  endLine: r.endColumn === 1 && r.endLine > r.startLine ? r.endLine - 1 : r.endLine,
});

const selector = <T extends RenderedReviewAnnotationV1["target"]["selectors"][number]["type"]>(
  a: RenderedReviewAnnotationV1,
  type: T,
) => a.target.selectors.find((s) => s.type === type) as Extract<(typeof a.target.selectors)[number], { type: T }>;
const sourceRange = (a: RenderedReviewAnnotationV1) => selector(a, "MarkdownSourceRangeSelector");

/**
 * Classify a review thread's comments by their metadata. The root's annotation replaces GitHub's
 * line anchor when it is valid and overlaps those lines (GitHub's anchor stays as the fallback);
 * otherwise GitHub's location is kept.
 */
function annotateThread(thread: NativeThread, context: CommentContext): NativeThread {
  const metadata: Record<number, Classification> = {};
  for (const c of thread.comments as ReviewComment[]) {
    const classification = classifyComment(c, context);
    if (classification.state !== "native") metadata[c.id] = classification;
  }
  if (!Object.keys(metadata).length) return thread;
  const annotation = metadata[thread.comments[0]!.id]?.annotation;
  const native = thread.anchor;
  const lines = annotation && anchorLines({ type: "annotation", annotation });
  const agrees =
    lines &&
    native.type === "current" &&
    native.side === "RIGHT" &&
    lines.startLine <= native.endLine &&
    lines.endLine >= native.startLine;
  return { ...thread, metadata, ...(agrees && { anchor: { type: "annotation", annotation, fallback: native } }) };
}

/** Words an annotation selects, for word-precise highlighting of its source range. */
export interface AnnotationRange {
  kind: "annotation";
  sourceRange: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  textQuote: { exact: string; prefix?: string; suffix?: string };
}

export interface ThreadPlacement {
  thread: NativeThread;
  /** Blocks to highlight; empty for file-scope and outdated threads, or when the side's document is missing. */
  blocks: SourceNode[];
  /** Annotation verified against the displayed blob: the exact words within `blocks`. */
  range?: AnnotationRange;
  /** Why the thread is not placed, when that needs saying. */
  reason?: string;
  /** The annotation does not match the blob it names: show "Metadata damaged" with this reason. */
  damaged?: string;
  /** How an annotation made on an earlier blob was re-anchored: moved placements, suggested locations. */
  reanchor?: ReanchorResult;
}

/** Why a re-anchored annotation is not placed. */
function unplacedReason(r: ReanchorResult): string {
  if (r.state === "ambiguous") return `The quoted text now appears in ${r.candidates.length} places`;
  if (r.state === "unavailable") return "The original version of this document is no longer available";
  return "The quoted text changed since this comment";
}

/**
 * Place a file's threads on its rendered documents: RIGHT-side lines on the head blob, LEFT-side
 * lines on the base blob. Outdated threads stay unplaced for the historical view. A deleted file
 * has no head: pass only `base`.
 */
export function placeThreads(
  threads: NativeThread[],
  path: string,
  docs: {
    head?: RenderedMarkdown;
    base?: RenderedMarkdown;
    /** The head blob `head` was rendered from; annotations are placed only on the blob they name. */
    blob?: { oid: string; source: string };
  },
): ThreadPlacement[] {
  const lineBlocks = (a: NativeAnchor | undefined) => {
    const doc = a?.type === "current" ? (a.side === "LEFT" ? docs.base : docs.head) : undefined;
    return doc && a?.type === "current" ? blocksForLines(doc, a.startLine, a.endLine) : [];
  };
  return threads
    .filter((t) => t.path === path)
    .map((thread): ThreadPlacement => {
      const a = thread.anchor;
      if (a.type !== "annotation") return { thread, blocks: lineBlocks(a) };
      const { head, blob } = docs;
      if (!head || !blob) return { thread, blocks: lineBlocks(a.fallback) };
      const { exact, prefix, suffix } = selector(a.annotation, "TextQuoteSelector");
      const textQuote = { exact, ...(prefix !== undefined && { prefix }), ...(suffix !== undefined && { suffix }) };
      const at = (range: AnnotationRange["sourceRange"], extra: Partial<ThreadPlacement> = {}): ThreadPlacement => {
        return {
          thread,
          blocks: blocksForLines(head, range.startLine, rangeLines(range).endLine),
          range: { kind: "annotation", sourceRange: range, textQuote },
          ...extra,
        };
      };
      if (blob.oid !== a.annotation.target.blobOid) {
        const r = reanchor({ annotation: a.annotation, blobOid: blob.oid, source: blob.source, doc: head });
        // Reworded text is placed on its block only: no word range claims precision it lacks.
        if (r.approximate)
          return {
            thread,
            blocks: blocksForLines(head, r.sourceRange!.startLine, rangeLines(r.sourceRange!).endLine),
            reanchor: r,
          };
        if (r.sourceRange) return at(r.sourceRange, { reanchor: r });
        return a.fallback
          ? { thread, blocks: lineBlocks(a.fallback), reanchor: r }
          : { thread, blocks: [], reason: unplacedReason(r), reanchor: r };
      }
      const check = verifyContent(a.annotation, blob.source, head);
      if (!check.ok) return { thread, blocks: lineBlocks(a.fallback), damaged: check.reason };
      const { startLine, startColumn, endLine, endColumn } = sourceRange(a.annotation);
      return at({ startLine, startColumn, endLine, endColumn });
    });
}

/**
 * Body to show for a thread comment. The quote and permalink repeat what the highlight shows, so
 * they are hidden, but only when the thread's anchor was verified against the document (`verified`,
 * i.e. its placement has a `range`) and the comment's own validated annotation names that same target.
 */
export function displayBody(thread: NativeThread, comment: ThreadComment, verified: boolean): string {
  const anchor = thread.anchor.type === "annotation" ? thread.anchor.annotation : undefined;
  const own = thread.metadata?.[comment.id]?.annotation;
  const same = !!anchor && !!own && JSON.stringify(own.target) === JSON.stringify(anchor.target);
  return own ? stripRedundantContext(comment.body, own, verified && same) : comment.body;
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
    const own = threads.filter((t) => {
      const root = t.comments[0]!;
      return "reviewId" in root && root.reviewId === review.id;
    });
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
