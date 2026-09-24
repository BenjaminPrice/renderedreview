// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeText } from "@rendered-review/markdown-domain";
import type { AnnotationSelector, RenderedReviewAnnotationV1 } from "./annotation.js";
import { encodeAnnotation } from "./envelope.js";

/**
 * Where GitHub stores the comment:
 * - `review-line`: native review comment on diff lines. GitHub shows the location itself.
 * - `review-file`: file-level review comment. GitHub knows the file but not the lines.
 * - `conversation`: PR conversation comment. GitHub knows neither.
 */
export type CommentLocation = "review-line" | "review-file" | "conversation";

type Selector<T extends AnnotationSelector["type"]> = Extract<AnnotationSelector, { type: T }>;
const selector = <T extends AnnotationSelector["type"]>(a: RenderedReviewAnnotationV1, type: T) =>
  a.target.selectors.find((s): s is Selector<T> => s.type === type)!;

/**
 * Markdown blockquote that renders as exactly `text`. Every ASCII punctuation character is
 * backslash-escaped (CommonMark allows it for all of them), which also defuses GitHub-only syntax
 * such as `@mentions`, `#123` references and `:emoji:` codes. Leading and trailing spaces and tabs
 * become character references so they are neither indentation nor hard breaks (whitespace next to
 * a line break is still dropped by renderers; rendered selections never contain it). Blank lines
 * stay paragraph breaks.
 */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const escaped = line
        .replace(/[!-/:-@[-`{-~]/g, "\\$&")
        .replace(/^[ \t]+|[ \t]+$/g, (ws) => ws.replace(/ /g, "&#32;").replace(/\t/g, "&#9;"));
      return escaped === "" ? ">" : `> ${escaped}`;
    })
    .join("\n");
}

/** Inline code span that survives backticks in `text`. */
function codeSpan(text: string): string {
  const fence = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Fenced block with a fence longer than any backtick run inside `text`. */
function fenced(info: string, text: string): string {
  const fence = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${fence}${info}\n${text === "" ? "" : `${text}\n`}${fence}`;
}

/**
 * Immutable GitHub link to the annotated source lines. `?plain=1` makes GitHub show the source
 * view, where line anchors work, instead of the rendered Markdown.
 */
export function permalink(annotation: RenderedReviewAnnotationV1): string {
  const { githubHost, repository, commitOid, path } = annotation.target;
  const range = selector(annotation, "MarkdownSourceRangeSelector");
  // The range is half-open: ending at column 1 means the previous line was the last one selected.
  const endLine = range.endColumn === 1 && range.endLine > range.startLine ? range.endLine - 1 : range.endLine;
  const encodedPath = path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
  return `https://${githubHost}/${repository}/blob/${commitOid}/${encodedPath}?plain=1#L${range.startLine}-L${endLine}`;
}

const permalinkLine = (a: RenderedReviewAnnotationV1) => `Document: [${codeSpan(a.target.path)}](${permalink(a)})`;
const quoteBlock = (a: RenderedReviewAnnotationV1) => quote(selector(a, "TextQuoteSelector").exact);
const join = (...parts: string[]) => parts.filter((p) => p.trim() !== "").join("\n\n");

/**
 * GitHub comment body that reads well without Rendered Review: the selected text as a blockquote,
 * the reviewer's comment, a permalink when GitHub has no line location (`review-file`,
 * `conversation`), and the annotation marker last on its own line.
 *
 * Native line comments also carry the quote: GitHub shows whole lines, and a Markdown paragraph is
 * usually one long line, so the quote is what says which words the comment is about.
 */
export function composeCommentBody(input: {
  annotation: RenderedReviewAnnotationV1;
  comment: string;
  location: CommentLocation;
}): string {
  const { annotation, comment, location } = input;
  return join(
    quoteBlock(annotation),
    comment,
    location === "review-line" ? "" : permalinkLine(annotation),
    encodeAnnotation(annotation),
  );
}

function assertSuggesting(annotation: RenderedReviewAnnotationV1) {
  if (annotation.motivation !== "suggesting") throw new TypeError('Suggestions need motivation "suggesting"');
}

/**
 * Native GitHub suggestion for a diff range GitHub accepts suggestions on. `replacement` replaces
 * the commented lines; an empty string suggests deleting them.
 */
export function composeSuggestionBody(input: {
  annotation: RenderedReviewAnnotationV1;
  comment: string;
  replacement: string;
}): string {
  assertSuggesting(input.annotation);
  return join(input.comment, fenced("suggestion", input.replacement), encodeAnnotation(input.annotation));
}

/**
 * Proposed change outside the pull request diff, where GitHub cannot apply suggestions: the quote,
 * the comment, a note that it must be applied manually, a `diff` block from `original` to
 * `replacement` source lines, the permalink, and the marker.
 */
export function composeExtendedSuggestionBody(input: {
  annotation: RenderedReviewAnnotationV1;
  comment: string;
  original: string;
  replacement: string;
}): string {
  const { annotation, comment, original, replacement } = input;
  assertSuggesting(annotation);
  const lines = (text: string, sign: string) => (text === "" ? [] : text.split("\n").map((l) => sign + l));
  return join(
    quoteBlock(annotation),
    comment,
    "**Suggested change** (apply it manually; GitHub cannot apply suggestions outside the pull request diff):",
    fenced("diff", [...lines(original, "-"), ...lines(replacement, "+")].join("\n")),
    permalinkLine(annotation),
    encodeAnnotation(annotation),
  );
}

/**
 * Body for in-app display, where the quote is shown as a highlight and the location is known.
 * Hides the leading quote (and the permalink line, if unchanged) only when the caller has fully
 * validated the annotation and the quote in the body still renders the annotation's exact text.
 * Otherwise, for example after the quote was edited on GitHub, returns the body unchanged.
 */
export function stripRedundantContext(
  body: string,
  annotation: RenderedReviewAnnotationV1,
  validated: boolean,
): string {
  if (!validated) return body;
  const text = normalizeText(body);
  const lead = `${normalizeText(quoteBlock(annotation))}\n\n`;
  if (!text.startsWith(lead)) return body;
  const link = normalizeText(permalinkLine(annotation));
  return text
    .slice(lead.length)
    .split("\n\n")
    .filter((paragraph) => paragraph !== link)
    .join("\n\n");
}
