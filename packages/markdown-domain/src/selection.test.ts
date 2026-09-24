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

describe("blocks map inside their own source", () => {
  test("code and diagram fences map to lines inside the fence", () => {
    const md = "Intro\n\n```ts\nconst a = 1;\nlet b;\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n";
    const s = ok(select(md, "let b"));
    expect(s).toMatchObject({ nodeType: "code", sourceRange: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 6 } });
    expect(claimed(md, select(md, "A-->B"))).toBe("A-->B");
    // "t" also appears in the info string; the content starts after the opening fence.
    expect(ok(select("```ts\nt\n```\n", "t")).sourceRange.startLine).toBe(2);
  });

  test("an indented fence in a CRLF list", () => {
    const md = "- x\r\n\r\n  ```\r\n  k\r\n   l\r\n  ```\r\n";
    expect(ok(select(md, "l")).sourceRange).toEqual({ startLine: 5, startColumn: 4, endLine: 5, endColumn: 5 });
  });

  test("table cells map to cell source; cells of one row stay precise", () => {
    const md = "| a | b |\n|---|---|\n| cell one | two |\n";
    const s = ok(select(md, "one"));
    expect(s.nodeType).toBe("tableCell");
    expect(claimed(md, select(md, "one"))).toBe("one");
    const row = select(md, "one", "two");
    expect(claimed(md, row)).toBe("one | two");
    expect(ok(row)).toMatchObject({ nodeType: "tableRow", expanded: false });
  });

  test("task list items, without the checkbox", () => {
    const md = "- [ ] write tests\n- [x] ship\n";
    expect(claimed(md, select(md, "write"))).toBe("write");
    expect(ok(select(md, "write")).nodeType).toBe("listItem");
  });

  test("footnotes: definitions map to their source, references to their label", () => {
    const md = "Text[^n] here.\n\n[^n]: The note.\n";
    const s = ok(select(md, "The note."));
    expect(claimed(md, select(md, "The note."))).toBe("The note.");
    expect(s.sourceRange.startLine).toBe(3);
    // The rendered number is not in the source: the whole reference is claimed.
    expect(claimed(md, select(md, "1"))).toBe("[^n]");
  });

  test("front matter values and keys", () => {
    const md = '---\ntitle: "Hello world"\ntags: [a, b]\n---\n\nBody\n';
    expect(claimed(md, select(md, "world"))).toBe("world");
    expect(ok(select(md, "world"))).toMatchObject({ nodeType: "yamlValue", sourceRange: { startLine: 2 } });
    expect(claimed(md, select(md, "tags"))).toBe("tags");
  });

  test("alerts: body text maps, the generated title does not", () => {
    const md = "> [!NOTE]\n> Useful info here.\n";
    expect(ok(select(md, "info")).sourceRange).toMatchObject({ startLine: 2, startColumn: 10 });
    // Starting in the title moves the start to the first document character.
    const s = ok(select(md, "Note", "Useful"));
    expect(s.exact).toBe("Useful");
    expect(claimed(md, select(md, "Note", "Useful"))).toBe("Useful");
    expect(select(md, "Note")).toMatchObject({ ok: false, reason: "generated" });
  });

  test("inert MDX maps to its exact source; labels are left out of the quote", () => {
    const md = '<Note title="x">\n\nHello *there*\n\n</Note>\n\nText {1+1} after\n';
    const mdx = { format: "mdx" } as const;
    expect(claimed(md, select(md, "1+1", "1+1", mdx))).toBe("1+1");
    const s = ok(select(md, "Text", "after", mdx));
    expect(s.exact).toBe("Text {1+1} after");
    expect(claimed(md, select(md, "Text", "after", mdx))).toBe("Text {1+1} after");
    expect(claimed(md, select(md, "there", "there", mdx))).toBe("there");
    expect(claimed(md, select(md, "title", "title", mdx))).toBe("title");
  });

  test("raw HTML text", () => {
    const md = "<div>raw &amp; <b>bold</b></div>\n";
    expect(claimed(md, select(md, "& bold"))).toBe("&amp; <b>bold");
  });
});

describe("selections across blocks widen to whole blocks or are rejected", () => {
  test("two paragraphs: the claim and the quote cover both", () => {
    const md = "# H\n\nFirst para.\n\nSecond para.\n";
    const s = ok(select(md, "para.", "Second"));
    expect(s).toMatchObject({
      expanded: true,
      exact: "First para.\nSecond para.",
      nodeType: "root",
      sourceRange: { startLine: 3, startColumn: 1, endLine: 5, endColumn: 13 },
      headingPath: ["H"],
    });
    expect(s.blockIds).toHaveLength(2);
    expect(claimed(md, select(md, "para.", "Second"))).toBe("First para.\n\nSecond para.");
  });

  test("list items widen to the items, not the whole list", () => {
    const md = "- one\n- two\n- three\n";
    const s = ok(select(md, "ne", "tw"));
    expect(claimed(md, select(md, "ne", "tw"))).toBe("- one\n- two");
    expect(s).toMatchObject({ nodeType: "list", expanded: true });
  });

  test("a nested list widens to the enclosing item", () => {
    const md = "- outer\n  - inner\n- next\n";
    expect(claimed(md, select(md, "uter", "inn"))).toBe("- outer\n  - inner");
  });

  test("never claims part of a JSX element", () => {
    const md = "<Note>\n\nInside text\n\n</Note>\n\nAfter\n";
    expect(claimed(md, select(md, "text", "After", { format: "mdx" }))).toBe(md.trimEnd());
  });

  test("table rows widen to the rows", () => {
    const md = "| a | b |\n|---|---|\n| c | d |\n| e | f |\n";
    expect(claimed(md, select(md, "d", "e"))).toBe("| c | d |\n| e | f |");
  });

  test("front matter rows widen to the rows", () => {
    const md = "---\ntitle: Hello\ntags: [a, b]\n---\n\nBody\n";
    expect(claimed(md, select(md, "Hello", "tags"))).toBe("title: Hello\ntags: [a, b]");
  });

  test("front matter into the body is rejected", () => {
    const md = "---\ntitle: Hello\n---\n\nBody\n";
    expect(select(md, "Hello", "Body")).toMatchObject({ ok: false, reason: "frontmatter" });
  });

  test("a collapsed selection is rejected", () => {
    const md = "Some text\n";
    const doc = renderMarkdown(md);
    const p = at(doc.tree, "text", "start");
    expect(selectionToSource(doc, md, p, p)).toMatchObject({ ok: false, reason: "empty" });
  });

  test("into a footnote: covers the source between the reference and the definition", () => {
    const md = "Text[^n] here.\n\nMiddle.\n\n[^n]: The note.\n";
    expect(claimed(md, select(md, "here", "The note"))).toBe(md.trimEnd());
  });
});
