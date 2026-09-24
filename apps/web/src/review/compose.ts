// SPDX-License-Identifier: AGPL-3.0-only
// What a new comment on a rendered selection becomes: its annotation, its GitHub representation,
// its body, and the publish intent. Pure.
import {
  composeCommentBody,
  encodeAnnotation,
  type RenderedReviewAnnotationV1,
} from "@rendered-review/annotation-domain";
import type { ChangedFile } from "@rendered-review/github-integration";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import { chooseRepresentation, type Representation } from "@rendered-review/review-domain";
import type { CommentIntent } from "./publish";

/** The document revision a comment is written against. */
export interface CommentTarget {
  host: string;
  repositoryId: number;
  /** `owner/name`. */
  repository: string;
  pullRequest: number;
  path: string;
  commitOid: string;
  blobOid: string;
}

export type PreparedAnnotation = { ok: true; annotation: RenderedReviewAnnotationV1 } | { ok: false; message: string };

/**
 * The annotation for a comment on `selection`, checked to encode: a quote too long for the marker
 * is refused (never truncated) with a request for a narrower selection.
 */
export function prepareAnnotation(target: CommentTarget, selection: SourceSelection): PreparedAnnotation {
  const { exact, prefix, suffix, textPosition, sourceRange, nodeType, headingPath } = selection;
  const annotation: RenderedReviewAnnotationV1 = {
    version: 1,
    target: {
      githubHost: target.host,
      repositoryId: target.repositoryId,
      repository: target.repository,
      pullRequest: target.pullRequest,
      path: target.path,
      commitOid: target.commitOid,
      blobOid: target.blobOid,
      selectors: [
        { type: "TextQuoteSelector", exact, prefix, suffix },
        { type: "TextPositionSelector", ...textPosition },
        { type: "MarkdownSourceRangeSelector", ...sourceRange },
      ],
      structure: { nodeType, headingPath },
    },
    motivation: "commenting",
    createdBy: "rendered-review",
  };
  try {
    encodeAnnotation(annotation);
    return { ok: true, annotation };
  } catch (error) {
    if (error instanceof RangeError)
      return { ok: false, message: "This selection is too long to comment on. Select a shorter passage." };
    return { ok: false, message: `This selection can't be commented on: ${(error as Error).message}` };
  }
}

/** How GitHub will store a comment on `selection` in the document at `path`. */
export function representationFor(files: ChangedFile[], path: string, selection: SourceSelection): Representation {
  const { startLine, endLine, endColumn } = selection.sourceRange;
  // The range is half-open: ending at column 1 means the previous line was the last one selected.
  const last = endColumn === 1 && endLine > startLine ? endLine - 1 : endLine;
  return chooseRepresentation({ file: files.find((f) => f.path === path), range: { startLine, endLine: last } });
}

/** The GitHub body for `comment` on the annotated selection. */
export const composeDraftBody = (annotation: RenderedReviewAnnotationV1, comment: string, representation: Representation) =>
  composeCommentBody({ annotation, comment, location: representation.kind });

/** What the publish boundary needs for one comment. */
export function commentIntent(
  c: { body: string; path: string; representation: Representation },
  expectedHeadOid: string,
): CommentIntent {
  const r = c.representation;
  const common = { body: c.body, expectedHeadOid };
  if (r.kind === "conversation") return { ...common, representation: "conversation" };
  if (r.kind === "review-file") return { ...common, representation: "review-file", path: c.path };
  return {
    ...common,
    representation: "review-line",
    path: c.path,
    line: r.line,
    side: r.side,
    ...(r.startLine !== undefined && { startLine: r.startLine, startSide: r.startSide }),
  };
}
