// SPDX-License-Identifier: AGPL-3.0-only
import type { Element, Root } from "hast";
import { toString } from "hast-util-to-string";
import { describe, expect, test } from "vitest";
import { renderMarkdown, type RenderOptions } from "./render.js";
import { type RenderedPoint, selectionToSource, type SelectionResult } from "./selection.js";

/**
 * A rendered point at the start or end of the `nth` occurrence of `needle`, relative to the
 * innermost stamped element containing it (what the DOM adapter reports).
 */
function at(tree: Root, needle: string, edge: "start" | "end", nth = 0): RenderedPoint {
  const hits: Element[] = [];
  const walk = (el: Root | Element): boolean => {
    let inner = false;
    for (const c of el.children) if (c.type === "element" && walk(c)) inner = true;
    if (el.type !== "element" || !toString(el).includes(needle)) return inner;
    if (!inner && el.properties.dataRrId !== undefined) hits.push(el);
    return inner || el.properties.dataRrId !== undefined;
  };
  walk(tree);
  const el = hits[nth];
  if (!el) throw new Error(`"${needle}" #${nth} not found`);
  const offset = toString(el).indexOf(needle) + (edge === "end" ? needle.length : 0);
  return { id: el.properties.dataRrId as number, offset };
}

/** Select from the start of `from` to the end of `to` (default: `from` itself). */
function select(source: string, from: string, to = from, options: RenderOptions & { nth?: [number, number] } = {}) {
  const doc = renderMarkdown(source, options);
  const [a, b] = options.nth ?? [0, 0];
  return selectionToSource(doc, source, at(doc.tree, from, "start", a), at(doc.tree, to, "end", b));
}

function ok(result: SelectionResult) {
  if (!result.ok) throw new Error(`rejected: ${result.message}`);
  return result.selection;
}

/** The raw source the selection claims. */
const claimed = (source: string, result: SelectionResult) =>
  source.slice(ok(result).textPosition.start, ok(result).textPosition.end);

describe("inline selections map to the tightest source span", () => {
  const src = "# Title\n\nHello brave new world.\n";

  test("a plain word", () => {
    const s = ok(select(src, "brave"));
    expect(s).toMatchObject({
      exact: "brave",
      prefix: "Title\nHello ",
      suffix: " new world.",
      textPosition: { start: 15, end: 20 },
      sourceRange: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 12 },
      nodeType: "paragraph",
      headingPath: ["Title"],
      expanded: false,
    });
    expect(s.blockIds).toHaveLength(1);
  });

  test("bounds prefix and suffix to 32 characters", () => {
    const long = `${"a".repeat(40)} target ${"b".repeat(40)}\n`;
    const s = ok(select(long, "target"));
    expect(s.prefix).toBe(`${"a".repeat(31)} `);
    expect(s.suffix).toBe(` ${"b".repeat(31)}`);
  });

  test("emphasis: markup inside the selection is claimed, markup outside is not", () => {
    const md = "Use **bold** text\n";
    expect(claimed(md, select(md, "bold"))).toBe("bold");
    expect(claimed(md, select(md, "bold text"))).toBe("bold** text");
    expect(claimed(md, select(md, "Use bold"))).toBe("Use **bold");
    expect(ok(select(md, "bold text")).exact).toBe("bold text");
  });

  test("links keep their destination when the selection crosses them", () => {
    const md = "See [the docs](https://x.y) now\n";
    expect(claimed(md, select(md, "docs now"))).toBe("docs](https://x.y) now");
    expect(claimed(md, select(md, "the"))).toBe("the");
  });

  test("code spans", () => {
    const md = "Run `npm ci` first\n";
    expect(claimed(md, select(md, "npm"))).toBe("npm");
    expect(claimed(md, select(md, "Run npm ci first"))).toBe("Run `npm ci` first");
  });

  test("character references claim the whole reference", () => {
    const md = "Tom &amp; Jerry &#169; 2026\n";
    expect(claimed(md, select(md, "&"))).toBe("&amp;");
    expect(claimed(md, select(md, "©"))).toBe("&#169;");
    expect(claimed(md, select(md, "Tom & Jerry"))).toBe("Tom &amp; Jerry");
  });

  test("backslash escapes claim the backslash", () => {
    const md = "2 \\* 3\n";
    expect(claimed(md, select(md, "*"))).toBe("\\*");
  });

  test("CRLF files: raw offsets, normalized quote", () => {
    const md = "one\r\ntwo *three*\r\n";
    const s = ok(select(md, "one\r\ntwo"));
    expect(s.exact).toBe("one\ntwo");
    expect(claimed(md, select(md, "one\r\ntwo"))).toBe("one\r\ntwo");
    expect(ok(select(md, "three")).sourceRange).toEqual({ startLine: 2, startColumn: 6, endLine: 2, endColumn: 11 });
  });
});
