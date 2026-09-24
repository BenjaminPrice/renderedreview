// SPDX-License-Identifier: AGPL-3.0-only
// What a new comment on a rendered selection becomes: its annotation, its GitHub representation,
// its body, and the publish intent. Pure.
import {
  composeCommentBody,
  composeExtendedSuggestionBody,
  composeSuggestionBody,
  encodeAnnotation,
  type RenderedReviewAnnotationV1,
} from "@rendered-review/annotation-domain";
import type { ChangedFile } from "@rendered-review/github-integration";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import { chooseRepresentation, suggestionEligible, type Representation } from "@rendered-review/review-domain";
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

/** The 1-based inclusive source lines `selection` touches. */
export function selectedLines({ sourceRange: r }: SourceSelection) {
  // The range is half-open: ending at column 1 means the previous line was the last one selected.
  return { startLine: r.startLine, endLine: r.endColumn === 1 && r.endLine > r.startLine ? r.endLine - 1 : r.endLine };
}

/** How GitHub will store a comment on `selection` in the document at `path`. */
export function representationFor(files: ChangedFile[], path: string, selection: SourceSelection): Representation {
  return chooseRepresentation({ file: files.find((f) => f.path === path), range: selectedLines(selection) });
}

/** The whole source lines `selection` touches, which a suggestion replaces (GitHub suggests whole lines). */
export function selectedSourceLines(source: string, selection: SourceSelection): string {
  const { startLine, endLine } = selectedLines(selection);
  return source
    .split(/\r?\n/)
    .slice(startLine - 1, endLine)
    .join("\n");
}

/** Replacement `replacement` for the source lines `original`. */
export interface SuggestedChange {
  original: string;
  replacement: string;
}

/**
 * The GitHub body for `comment` on the annotated selection. With a suggestion: a native
 * suggestion where GitHub can apply one, else a proposed change to apply manually.
 */
export function composeDraftBody(
  annotation: RenderedReviewAnnotationV1,
  comment: string,
  representation: Representation,
  suggestion?: SuggestedChange,
): string {
  if (!suggestion)
    return composeCommentBody({
      annotation: { ...annotation, motivation: "commenting" },
      comment,
      location: representation.kind,
    });
  const suggesting = { ...annotation, motivation: "suggesting" as const };
  return suggestionEligible(representation)
    ? composeSuggestionBody({ annotation: suggesting, comment, replacement: suggestion.replacement })
    : composeExtendedSuggestionBody({ annotation: suggesting, comment, ...suggestion });
}

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
