// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeText, type RenderedMarkdown, renderedText } from "@rendered-review/markdown-domain";
import type { AnnotationSelector, RenderedReviewAnnotationV1 } from "./annotation.js";

export type ContentCheck = { ok: true } | { ok: false; reason: string };

type Selector<T extends AnnotationSelector["type"]> = Extract<AnnotationSelector, { type: T }>;
const selector = <T extends AnnotationSelector["type"]>(a: RenderedReviewAnnotationV1, type: T) =>
  a.target.selectors.find((s): s is Selector<T> => s.type === type)!;

/**
 * Check an annotation against the blob it references (`source`, rendered as `rendered`):
 *
 * 1. The source range lies inside the blob.
 * 2. The text position (0-based UTF-16 offsets into the raw blob, end exclusive) is exactly the
 *    source range's span.
 * 3. The quote is the rendered text that span claims, joined as `selectionToSource` joins it
 *    (`renderedText`): markup, generated labels and escapes are not part of it, whitespace between
 *    blocks is. So any claim the selection conversion makes, in one block or widened across
 *    blocks, verifies against its own blob.
 */
export function verifyContent(
  annotation: RenderedReviewAnnotationV1,
  source: string,
  rendered: RenderedMarkdown,
): ContentCheck {
  const range = selector(annotation, "MarkdownSourceRangeSelector");
  const exact = normalizeText(selector(annotation, "TextQuoteSelector").exact);
  // Offsets of each line start and end (before its line ending), as the Markdown parser counts them.
  const lines: { start: number; end: number }[] = [];
  const endings = /\r\n?|\n/g;
  let start = 0;
  for (const m of source.matchAll(endings)) {
    lines.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  lines.push({ start, end: source.length });
  const offset = (line: number, column: number) => {
    const l = lines[line - 1];
    return l && l.start + column - 1 <= l.end ? l.start + column - 1 : undefined;
  };
  const from = offset(range.startLine, range.startColumn);
  const to = offset(range.endLine, range.endColumn);
  if (from === undefined || to === undefined) return { ok: false, reason: "The source range is outside the document" };
  const position = selector(annotation, "TextPositionSelector");
  if (position.start !== from || position.end !== to)
    return { ok: false, reason: "The text position does not match the source range" };
  if (renderedText(rendered, source, { start: from, end: to }) === exact) return { ok: true };
  return { ok: false, reason: "The quoted text does not match the document at the source range" };
}
