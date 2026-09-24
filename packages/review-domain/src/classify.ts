// SPDX-License-Identifier: AGPL-3.0-only
// Classifies a loaded GitHub comment by its annotation metadata (design §6): which location to
// trust and which notice to show. Structural checks only; the referenced blob's content is
// checked by `verifyContent` once that document is loaded (see `placeThreads`).
import {
  extractAnnotation,
  type RenderedReviewAnnotationV1,
  stripRedundantContext,
} from "@rendered-review/annotation-domain";
import type { RepositoryRef } from "./projection.js";

/** The pull request a comment was loaded from. Annotations must name exactly this. */
export interface CommentContext extends RepositoryRef {
  repositoryId: number;
  pullRequest: number;
}

export type CommentState = "native" | "valid" | "edited-prose" | "edited-quote" | "missing" | "damaged" | "unsupported";

export interface Classification {
  state: CommentState;
  /** Set for `valid`, `edited-prose` and `edited-quote`: validated against the loaded pull request. */
  annotation?: RenderedReviewAnnotationV1;
  /** Why metadata is `damaged` or `unsupported`. */
  reason?: string;
  /** "Edited on GitHub". An edit alone does not invalidate the anchor. */
  edited: boolean;
}

// ponytail: REST has no edit timestamp; comments submitted with a pending review also get a later
// updated_at. GraphQL `lastEditedAt` is exact if this threshold misleads.
const EDIT_THRESHOLD_MS = 60_000;

/** GitHub bumps `updatedAt` a little on creation; only a later change counts as an edit. */
export function isEdited(c: { createdAt: string; updatedAt: string }): boolean {
  return Date.parse(c.updatedAt) - Date.parse(c.createdAt) > EDIT_THRESHOLD_MS;
}

// The permalink line application comments carry, left behind when only the marker is removed.
const PERMALINK_LINE = /^Document: \[`.+`\]\(https:\/\/\S+\/blob\/[0-9a-f]{40,64}\/\S+\?plain=1#L\d+-L\d+\)$/m;

/** Why an annotation does not belong to the comment it was loaded with, or `undefined` if it does. */
function mismatch(a: RenderedReviewAnnotationV1, context: CommentContext, path?: string): string | undefined {
  const t = a.target;
  if (t.githubHost.toLowerCase() !== context.host.toLowerCase()) return "The metadata names another GitHub host";
  if (t.repositoryId !== context.repositoryId) return "The metadata names another repository";
  // ponytail: a renamed repository reads as damaged; compare the ID only if renames matter.
  if (t.repository.toLowerCase() !== `${context.owner}/${context.name}`.toLowerCase())
    return "The metadata names another repository";
  if (t.pullRequest !== context.pullRequest) return "The metadata names another pull request";
  if (path !== undefined && t.path !== path) return "The metadata names another file than the comment";
}

/**
 * Classify a comment by its annotation (design §6 state table). Host, repository and pull request
 * are checked against `context` before the annotation is returned, so callers may build links and
 * placements from it. `comment.path` (review comments) must match the annotation's path.
 */
export function classifyComment(
  comment: { body: string; createdAt: string; updatedAt: string; path?: string },
  context: CommentContext,
): Classification {
  const edited = isEdited(comment);
  const found = extractAnnotation(comment.body);
  switch (found.status) {
    case "none":
      return { state: PERMALINK_LINE.test(comment.body) ? "missing" : "native", edited };
    case "unsupported":
      return { state: "unsupported", reason: `Unsupported annotation version ${found.version}`, edited };
    case "damaged":
      return { state: "damaged", reason: found.reason, edited };
  }
  const annotation = found.annotation;
  const reason = mismatch(annotation, context, comment.path);
  if (reason) return { state: "damaged", reason, edited };
  // A leading quote that is not the one the annotation would write was edited on GitHub.
  const quoteEdited =
    stripRedundantContext(comment.body, annotation, true) === comment.body && comment.body.trimStart().startsWith(">");
  return { state: quoteEdited ? "edited-quote" : edited ? "edited-prose" : "valid", annotation, edited };
}
