// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeText, renderMarkdown } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import type { AnnotationSelector, RenderedReviewAnnotationV1 } from "./annotation.js";
import { sampleAnnotation } from "./fixtures.js";
import { verifyContent } from "./verify.js";

const source = [
  "# Reliability",
  "",
  "The system retries failed requests indefinitely.",
  "",
  "It **retries failed** requests.",
  "",
].join("\n");
const rendered = renderMarkdown(source);

/** Raw-source offset of a 1-based line and column in `text` (LF line endings). */
const offset = (text: string, line: number, column: number) =>
  text
    .split("\n")
    .slice(0, line - 1)
    .reduce((n, l) => n + l.length + 1, 0) +
  column -
  1;

function at(
  exact: string,
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  position = { start: offset(source, startLine, startColumn), end: offset(source, endLine, endColumn) },
) {
  const selectors: AnnotationSelector[] = [
    { type: "TextQuoteSelector", exact },
    { type: "TextPositionSelector", ...position },
    { type: "MarkdownSourceRangeSelector", startLine, startColumn, endLine, endColumn },
  ];
  const a = sampleAnnotation();
  return { ...a, target: { ...a.target, selectors } } as RenderedReviewAnnotationV1;
}

describe("verifyContent", () => {
  it("accepts a quote that is exactly the source text at the range", () => {
    expect(verifyContent(at("retries failed requests", 3, 12, 3, 35), source, rendered)).toEqual({ ok: true });
  });

  it("accepts a quote across inline formatting when the enclosing element renders it", () => {
    expect(verifyContent(at("retries failed requests", 5, 4, 5, 31), source, rendered)).toEqual({ ok: true });
  });

  it("compares after normalization (CRLF, NFC)", () => {
    const crlf = source.replace(/\n/g, "\r\n").replace("retries", "rétries");
    const quote = "ré".normalize("NFC") + "tries failed requests";
    // Positions count the raw source, CR characters included: line 3 starts at 17, not 15.
    // The source spells é decomposed (2 code units), so the span is 24 long, as columns 12–36 say.
    const position = { start: 17 + 11, end: 17 + 35 };
    expect(normalizeText(crlf.slice(position.start, position.end))).toBe(quote);
    expect(verifyContent(at(quote, 3, 12, 3, 36, position), crlf, renderMarkdown(crlf))).toEqual({ ok: true });
  });

  it("reads text positions as raw-source offsets: the span of the source range", () => {
    const position = at("retries failed requests", 3, 12, 3, 35).target.selectors.find(
      (s) => s.type === "TextPositionSelector",
    );
    expect(position).toMatchObject({ start: 26, end: 49 });
    expect(source.slice(26, 49)).toBe("retries failed requests");
  });

  it.each<[string, RenderedReviewAnnotationV1]>([
    ["a quote that differs from the source", at("retries all requests", 3, 12, 3, 35)],
    ["a quote the enclosing element does not render", at("retries every request", 5, 4, 5, 31)],
    ["a range past the last line", at("retries failed requests", 99, 1, 99, 5, { start: 0, end: 5 })],
    ["a column past the end of its line", at("retries failed requests", 3, 12, 3, 80, { start: 26, end: 49 })],
    [
      "a text position off the source range's span",
      at("retries failed requests", 3, 12, 3, 35, { start: 25, end: 48 }),
    ],
    ["a text position in rendered-text offsets", at("retries failed requests", 3, 12, 3, 35, { start: 11, end: 34 })],
  ])("rejects %s", (_name, annotation) => {
    const result = verifyContent(annotation, source, rendered);
    expect(result.ok).toBe(false);
  });
});
