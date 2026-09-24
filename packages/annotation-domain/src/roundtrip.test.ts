// SPDX-License-Identifier: AGPL-3.0-only
// Property test: every selection the renderer's selection conversion produces verifies against
// its own blob, and a wrong quote never does.
import {
  type RenderedMarkdown,
  type RenderedPoint,
  renderMarkdown,
  type SourceSelection,
  selectionToSource,
} from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import adr from "../../markdown-domain/src/fixtures/adr-0007-use-postgres.md?raw";
import alerts from "../../markdown-domain/src/fixtures/alerts.md?raw";
import frontmatter from "../../markdown-domain/src/fixtures/frontmatter-docs.md?raw";
import docusaurus from "../../markdown-domain/src/fixtures/mdx-docusaurus.mdx?raw";
import rfd from "../../markdown-domain/src/fixtures/rfd-0042-rendered-review.md?raw";
import type { RenderedReviewAnnotationV1 } from "./annotation.js";
import { sampleAnnotation } from "./fixtures.js";
import { verifyContent } from "./verify.js";

const mixed = [
  "# Title",
  "",
  "Some **bold** and _emphasis_ with `code`, a [link](https://example.com) and &amp; \\* escapes.",
  "",
  "- first item",
  "- second *item*",
  "  - nested item",
  "",
  "1. one",
  "2. two",
  "",
  "| A | B |",
  "| --- | --- |",
  "| cell **one** | cell two |",
  "| cell three | cell four |",
  "",
  "> quoted *text*",
  "> across lines",
  "",
  "Last paragraph.",
  "",
].join("\n");

const DOCS: [string, string, boolean][] = [
  ["mixed", mixed, false],
  ["mixed with CRLF", mixed.replace(/\n/g, "\r\n"), false],
  ["adr", adr, false],
  ["alerts", alerts, false],
  ["front matter", frontmatter, false],
  ["rfd (tables, lists)", rfd, false],
  ["mdx", docusaurus, true],
];

/** The HAST shape read here. */
type Node = { type: string; value?: string; children?: Node[]; properties?: { dataRrId?: number } };

/** Text length of each stamped element's subtree, as rendered points count it. */
function lengths(doc: RenderedMarkdown): number[] {
  const out: number[] = [];
  const walk = (el: Node): number => {
    let n = 0;
    for (const c of el.children ?? [])
      if (c.type === "text") n += c.value!.length;
      else if (c.type === "element") n += walk(c);
    if (el.properties?.dataRrId !== undefined) out[el.properties.dataRrId] = n;
    return n;
  };
  walk(doc.tree as unknown as Node);
  return out;
}

/** Deterministic pseudo-random selections: in-block, across blocks, and whole-element spans. */
function selections(doc: RenderedMarkdown, source: string): SourceSelection[] {
  const len = lengths(doc);
  const ids = len.flatMap((n, id) => (n > 0 ? [id] : []));
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const pairs: [RenderedPoint, RenderedPoint][] = [];
  for (const id of ids)
    pairs.push([
      { id, offset: 0 },
      { id, offset: len[id]! },
    ]);
  for (let i = 0; i < 150; i++) {
    const a = ids[rand(ids.length)]!;
    const b = rand(3) ? a : ids[Math.min(ids.length - 1, ids.indexOf(a) + 1 + rand(6))]!;
    const x = rand(len[a]!);
    const y = a === b ? x + 1 + rand(len[a]! - x) : 1 + rand(len[b]!);
    pairs.push([
      { id: a, offset: x },
      { id: b, offset: y },
    ]);
  }
  return pairs.flatMap(([s, e]) => {
    const r = selectionToSource(doc, source, s, e);
    return r.ok ? [r.selection] : [];
  });
}

function annotate(s: SourceSelection, exact = s.exact): RenderedReviewAnnotationV1 {
  const a = sampleAnnotation();
  return {
    ...a,
    target: {
      ...a.target,
      selectors: [
        { type: "TextQuoteSelector", exact, prefix: s.prefix, suffix: s.suffix },
        { type: "TextPositionSelector", ...s.textPosition },
        { type: "MarkdownSourceRangeSelector", ...s.sourceRange },
      ],
    },
  };
}

describe.each(DOCS)("selections made in %s", (_name, source, mdx) => {
  const doc = renderMarkdown(source, mdx ? { format: "mdx" } : {});
  const all = selections(doc, source);

  it("cover in-block and expanded cross-block claims", () => {
    expect(all.length).toBeGreaterThan(50);
    expect(all.some((s) => s.expanded)).toBe(true);
    expect(all.some((s) => !s.expanded)).toBe(true);
  });

  it("all verify against their blob", () => {
    const failed = all.filter((s) => !verifyContent(annotate(s), source, doc).ok).map((s) => [s.exact, s.sourceRange]);
    expect(failed).toEqual([]);
  });

  it("reject a quote with a character added or dropped", () => {
    const accepted = all.filter(
      (s) =>
        verifyContent(annotate(s, `${s.exact}x`), source, doc).ok ||
        (s.exact.length > 1 && verifyContent(annotate(s, s.exact.slice(1)), source, doc).ok),
    );
    expect(accepted.map((s) => s.exact)).toEqual([]);
  });
});
