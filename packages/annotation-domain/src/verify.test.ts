// SPDX-License-Identifier: AGPL-3.0-only
import { renderMarkdown } from "@rendered-review/markdown-domain";
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

function at(exact: string, startLine: number, startColumn: number, endLine: number, endColumn: number) {
  const selectors: AnnotationSelector[] = [
    { type: "TextQuoteSelector", exact },
    { type: "TextPositionSelector", start: 0, end: exact.length },
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
    expect(verifyContent(at(quote, 3, 12, 3, 36), crlf, renderMarkdown(crlf))).toEqual({ ok: true });
  });

  it.each<[string, RenderedReviewAnnotationV1]>([
    ["a quote that differs from the source", at("retries all requests", 3, 12, 3, 35)],
    ["a quote the enclosing element does not render", at("retries every request", 5, 4, 5, 31)],
    ["a range past the last line", at("retries failed requests", 99, 1, 99, 5)],
    ["a column past the end of its line", at("retries failed requests", 3, 12, 3, 80)],
  ])("rejects %s", (_name, annotation) => {
    const result = verifyContent(annotation, source, rendered);
    expect(result.ok).toBe(false);
  });
});
