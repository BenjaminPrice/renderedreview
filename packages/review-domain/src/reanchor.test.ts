// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import { documentText, renderMarkdown, type RenderOptions } from "@rendered-review/markdown-domain";
import { describe, expect, test } from "vitest";
import { reanchor, type ReanchorInput } from "./reanchor.js";

/** A stand-in blob OID that differs whenever the content does. */
function oid(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(5);
}

/** The annotation a reader would create by selecting the `nth` occurrence of `quote` in `source`. */
function annotate(source: string, quote: string, nth = 0, options: RenderOptions = {}): RenderedReviewAnnotationV1 {
  const t = documentText(renderMarkdown(source, options), source);
  let at = -1;
  for (let i = 0; i <= nth; i++) at = t.text.indexOf(quote, at + 1);
  if (at < 0) throw new Error(`"${quote}" #${nth} not found`);
  const r = t.select(at, at + quote.length);
  if (!r.ok) throw new Error(r.message);
  const { exact, prefix, suffix, textPosition, sourceRange, nodeType, headingPath } = r.selection;
  return {
    version: 1,
    target: {
      githubHost: "github.com",
      repositoryId: 1,
      repository: "acme/docs",
      pullRequest: 1,
      path: "doc.md",
      commitOid: "c".repeat(40),
      blobOid: oid(source),
      selectors: [
        { type: "TextQuoteSelector", exact, prefix, suffix },
        { type: "TextPositionSelector", ...textPosition },
        { type: "MarkdownSourceRangeSelector", ...sourceRange },
      ],
      structure: { nodeType, headingPath },
    },
    motivation: "commenting",
  };
}

function run(
  before: string,
  after: string,
  quote: string,
  { nth = 0, original, ...options }: RenderOptions & { nth?: number; original?: ReanchorInput["original"] } = {},
) {
  const annotation = annotate(before, quote, nth, options);
  const result = reanchor({
    annotation,
    blobOid: oid(after),
    source: after,
    doc: renderMarkdown(after, options),
    ...(original && { original }),
  });
  const placed = result.textPosition && after.slice(result.textPosition.start, result.textPosition.end);
  return { result, placed };
}

const DOC = "# Guide\n\nThe service retries failed requests.\n\n## Limits\n\nEach client may send ten requests.\n";

describe("current: the stored location is still valid", () => {
  test("same blob: placed at the stored range without searching", () => {
    const annotation = annotate(DOC, "retries failed");
    const result = reanchor({ annotation, blobOid: oid(DOC), source: DOC, doc: renderMarkdown(DOC) });
    expect(result).toMatchObject({ state: "current", evidence: "same-blob", confidence: 1 });
    expect(DOC.slice(result.textPosition!.start, result.textPosition!.end)).toBe("retries failed");
    expect(result.sourceRange).toEqual({ startLine: 3, startColumn: 13, endLine: 3, endColumn: 27 });
  });

  test("different blob, same range, same quote (an edit further down)", () => {
    const { result, placed } = run(DOC, DOC + "\nA new closing paragraph.\n", "retries failed");
    expect(result).toMatchObject({ state: "current", evidence: "same-range", confidence: 1 });
    expect(placed).toBe("retries failed");
  });
});

describe("moved: a unique match elsewhere", () => {
  test("text inserted above shifts the quote; exact quote and context still match", () => {
    const after = DOC.replace("# Guide\n", "# Guide\n\nAn introduction was added here.\n");
    const { result, placed } = run(DOC, after, "retries failed");
    expect(result).toMatchObject({ state: "moved", evidence: "quote-context" });
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(placed).toBe("retries failed");
    expect(result.sourceRange!.startLine).toBe(5);
  });

  test("a paragraph moved within its section keeps its place by context", () => {
    const before = "# A\n\nFirst point here.\n\nSecond point, which we discuss.\n\nThird point here.\n";
    const after = "# A\n\nThird point here.\n\nFirst point here.\n\nSecond point, which we discuss.\n";
    const { result, placed } = run(before, after, "which we discuss");
    expect(result.state).toBe("moved");
    expect(placed).toBe("which we discuss");
  });

  test("a renamed heading: the paragraph below it moves, even though its heading path changed", () => {
    const after = DOC.replace("## Limits", "## Rate limits and quotas");
    const { result, placed } = run(DOC, after, "ten requests");
    expect(result).toMatchObject({ state: "moved", evidence: "quote-context" });
    expect(placed).toBe("ten requests");
  });

  test("an edit right next to the quote breaks context, but the quote is unique in its section", () => {
    const after = DOC.replace("The service retries failed requests.", "Our service always retries failed requests!");
    const { result, placed } = run(DOC, after, "retries failed");
    expect(result).toMatchObject({ state: "moved", evidence: "structure" });
    expect(result.confidence).toBeLessThan(0.9);
    expect(placed).toBe("retries failed");
  });

  test("a slightly reworded quote in the same block is a structural match with lower confidence", () => {
    const before = "# Guide\n\nThe service retries every failed request up to five times.\n\n## Other\n\nUnrelated.\n";
    const after = "# Guide\n\nThe service retries each failed request up to five times.\n\n## Other\n\nUnrelated.\n";
    const { result, placed } = run(before, after, "retries every failed request up to five");
    expect(result).toMatchObject({ state: "moved", evidence: "structure" });
    expect(result.confidence).toBeLessThan(0.8);
    expect(placed).toBe("retries each failed request up to five");
  });

  test("a CRLF version of the same document maps to raw CRLF offsets", () => {
    const after = DOC.replace(/\n/g, "\r\n");
    const { result, placed } = run(DOC, after, "ten requests");
    expect(result.state).toBe("moved");
    expect(placed).toBe("ten requests");
  });

  test("a quote spanning lines matches across a CRLF change", () => {
    const before = "# A\n\nline one\nline two\n";
    const { result, placed } = run(before, "Intro.\r\n\r\n" + before.replace(/\n/g, "\r\n"), "one\nline");
    expect(result.state).toBe("moved");
    expect(placed).toBe("one\r\nline");
  });
});

describe("duplicates never resolve without enough context", () => {
  const before = "# Notes\n\nCheck the logs. Then restart.\n\nIf that fails: Check the logs. Then escalate.\n";

  test("context tells two identical sentences apart", () => {
    const after = before.replace("# Notes\n", "# Notes\n\nA new first line.\n");
    const { result, placed } = run(before, after, "Check the logs.", { nth: 1 });
    expect(result.state).toBe("moved");
    expect(result.sourceRange!.startLine).toBe(7);
    expect(placed).toBe("Check the logs.");
  });

  test("identical sentences with changed context are ambiguous, never placed", () => {
    const after = "# Notes\n\nFirst, Check the logs. Next restart.\n\nOtherwise Check the logs. Next escalate.\n";
    const { result } = run(before, after, "Check the logs.");
    expect(result.state).toBe("ambiguous");
    expect(result.textPosition).toBeUndefined();
    expect(result.sourceRange).toBeUndefined();
    expect(result.candidates).toHaveLength(2);
  });

  test("duplicates without matching context are told apart by heading path", () => {
    const b = "# One\n\nSame line.\n\n# Two\n\nSame line.\n";
    const a = "# Zero\n\nSame line.\n\n# One\n\nSame line.\n\n# Two\n\nSame line.\n";
    const { result, placed } = run(b, a, "Same line.");
    expect(result.state).toBe("moved");
    expect(placed).toBe("Same line.");
    expect(result.sourceRange!.startLine).toBe(7);
  });

  test("a single remaining copy in another section is only a candidate", () => {
    const b = "# One\n\nKeep this sentence.\n\n# Two\n\nOther text.\n";
    const a = "# Two\n\nOther text. Keep this sentence.\n";
    const { result } = run(b, a, "Keep this sentence.");
    expect(result.state).toBe("outdated");
    expect(result.textPosition).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
  });
});

describe("unplaced: no safe anchor", () => {
  const after = DOC.replace("The service retries failed requests.", "Failed calls are not repeated.");

  test("outdated when the quote is gone", () => {
    const { result } = run(DOC, after, "retries failed");
    expect(result).toMatchObject({ state: "outdated", evidence: "none", confidence: 0 });
    expect(result.textPosition).toBeUndefined();
  });

  test("historical only when the original blob can still be rendered", () => {
    expect(run(DOC, after, "retries failed", { original: "available" }).result.state).toBe("historical-only");
  });

  test("unavailable when GitHub no longer provides the original blob", () => {
    expect(run(DOC, after, "retries failed", { original: "missing" }).result.state).toBe("unavailable");
  });

  test("a heavily reworded quote is offered as a candidate, never placed", () => {
    const before = "# Setup\n\nInstall the command line tools first.\n\nThen run it.\n";
    const after = "# Setup\n\nInstall all of the CLI tools up front.\n\nThen run it.\n";
    const { result } = run(before, after, "Install the command line tools first.");
    expect(result.state).toBe("outdated");
    expect(result.candidates!.length).toBeGreaterThan(0);
    expect(result.candidates![0]!.exact).toBe("Install all of the CLI tools up front.");
  });

  test("a renamed heading quoted itself is outdated with a suggested location", () => {
    const { result } = run(DOC, DOC.replace("## Limits", "## Limitations"), "Limits");
    expect(result.state).toBe("outdated");
    expect(result.candidates![0]!.exact).toBe("Limitations");
  });

  test("an annotation without context or structure falls back to exact position only", () => {
    const annotation = annotate(DOC, "retries failed");
    annotation.target.selectors[0] = { type: "TextQuoteSelector", exact: "retries failed" };
    delete annotation.target.structure;
    const after = "Intro.\n\n" + DOC;
    const result = reanchor({ annotation, blobOid: oid(after), source: after, doc: renderMarkdown(after) });
    expect(result.state).toBe("outdated");
    expect(result.candidates).toHaveLength(1);
  });
});

describe("rendered documents with generated text", () => {
  test("alerts: the generated title is not part of the text", () => {
    const b = "# A\n\n> [!WARNING]\n> Never delete the production database.\n";
    const a = "# A\n\nIntro.\n\n> [!WARNING]\n> Never delete the production database.\n";
    const { result, placed } = run(b, a, "delete the production");
    expect(result.state).toBe("moved");
    expect(placed).toBe("delete the production");
  });

  test("front matter values re-anchor", () => {
    const b = "---\ntitle: Release plan\nowner: Platform team\n---\n\n# Plan\n";
    const a = "---\ntitle: Release plan\nstatus: draft\nowner: Platform team\n---\n\n# Plan\n";
    const { result, placed } = run(b, a, "Platform team");
    expect(result.state).toBe("moved");
    expect(placed).toBe("Platform team");
  });

  test("MDX documents re-anchor around inert JSX", () => {
    const b = "import X from './x'\n\n# Doc\n\n<X prop={1} />\n\nPlain prose to review.\n";
    const a = "import X from './x'\nimport Y from './y'\n\n# Doc\n\n<X prop={1} />\n\nPlain prose to review.\n";
    const { result, placed } = run(b, a, "prose to review", { format: "mdx" });
    expect(result.state).toBe("moved");
    expect(placed).toBe("prose to review");
  });
});

describe("performance", () => {
  test("results are memoized by blob pair and annotation", () => {
    const after = "Intro.\n\n" + DOC;
    const input = { annotation: annotate(DOC, "ten requests"), blobOid: oid(after), source: after, doc: renderMarkdown(after) };
    expect(reanchor(input)).toBe(reanchor({ ...input, doc: renderMarkdown(after) }));
  });

  test("a large document re-anchors quickly, on both the exact and the fuzzy path", () => {
    const para = (i: number) => `Paragraph ${i} talks about topic ${i % 97} in some detail.\n\n`;
    const before = Array.from({ length: 4000 }, (_, i) => (i % 400 === 0 ? `# Part ${i}\n\n` : para(i))).join("");
    const after = "Preface.\n\n" + before.replace("Paragraph 3210 talks", "Paragraph 3210 speaks");
    const doc = renderMarkdown(after);
    const t0 = performance.now();
    const exact = reanchor({ annotation: annotate(before, "topic 9 in"), blobOid: oid(after), source: after, doc });
    const fuzzy = reanchor({
      annotation: annotate(before, "Paragraph 3210 talks about"),
      blobOid: oid(after),
      source: after,
      doc,
    });
    const elapsed = performance.now() - t0;
    expect(exact.state).toBe("moved");
    expect(fuzzy.state).not.toBe("current");
    expect(elapsed).toBeLessThan(1000);
  });
});
