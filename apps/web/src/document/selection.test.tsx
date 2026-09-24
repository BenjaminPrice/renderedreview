// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// DOM selection <-> source claims on the real rendered article, and the round trip back to a highlight.
import { readFileSync } from "node:fs";
import { renderMarkdown, type RenderOptions } from "@rendered-review/markdown-domain";
import { cleanup, render } from "@testing-library/react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { convertRange, highlightRanges } from "./selection";

afterEach(cleanup);

function mount(source: string, options: RenderOptions = {}) {
  const rendered = renderMarkdown(source, options);
  const { container } = render(<article>{toJsxRuntime(rendered.tree, { Fragment, jsx, jsxs })}</article>);
  return { rendered, source, article: container.querySelector("article")! };
}

/** A DOM range over the `nth` occurrence of `needle` in the article's text. */
function rangeOf(article: HTMLElement, needle: string, nth = 0): Range {
  const texts: [Text, number][] = [];
  let flat = "";
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    texts.push([t, flat.length]);
    flat += t.data;
  }
  let at = -1;
  for (let i = 0; i <= nth; i++) at = flat.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`"${needle}" not found`);
  const locate = (g: number, end: boolean): [Text, number] => {
    const hit = texts.findLast(([t, from]) => (end ? from < g : from <= g) && g <= from + t.length)!;
    return [hit[0], g - hit[1]];
  };
  const range = document.createRange();
  range.setStart(...locate(at, false));
  range.setEnd(...locate(at + needle.length, true));
  return range;
}

type Mounted = ReturnType<typeof mount>;
const convert = ({ article, rendered, source }: Mounted, range: Range) => {
  const result = convertRange(article, rendered, source, range);
  if (!result?.ok) throw new Error(`not converted: ${result?.message}`);
  return result.selection;
};
const highlighted = (m: Mounted, range: Range) =>
  highlightRanges(m.article, m.rendered, m.source, convert(m, range).textPosition)
    .map((r) => r.toString())
    .join("|");

describe("DOM ranges convert to source claims", () => {
  test("text node offsets inside nested inline elements", () => {
    const m = mount("Use **bold** and [a link](x) here\n");
    const s = convert(m, rangeOf(m.article, "bold and a"));
    expect(m.source.slice(s.textPosition.start, s.textPosition.end)).toBe("bold** and [a");
  });

  test("element boundaries, as after a triple click", () => {
    const m = mount("First para.\n\nSecond para.\n");
    const [p1, p2] = m.article.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(p1!, 0);
    range.setEnd(p2!, 0);
    expect(convert(m, range)).toMatchObject({ exact: "First para.", expanded: false });
  });

  test("boundaries between blocks, outside any mapped element", () => {
    const m = mount("First para.\n\nSecond para.\n");
    const range = document.createRange();
    range.setStart(m.article, 0);
    range.setEnd(m.article, m.article.childNodes.length);
    expect(convert(m, range)).toMatchObject({ exact: "First para.\nSecond para.", expanded: true });
  });

  test("table cells, whose whitespace React drops", () => {
    const m = mount("| a | b |\n|---|---|\n| cell one | two |\n");
    const s = convert(m, rangeOf(m.article, "two"));
    expect(m.source.slice(s.textPosition.start, s.textPosition.end)).toBe("two");
  });

  test("a range outside the article converts to nothing", () => {
    const m = mount("Text\n");
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    expect(convertRange(m.article, m.rendered, m.source, range)).toBeNull();
    outside.remove();
  });
});

describe("round trip: select, convert, re-highlight the same rendered text", () => {
  // [source, selected rendered text, highlighted runs (default: the selection), options]
  const cases: [string, string, string?, RenderOptions?][] = [
    ["Use **bold** text and `code` and [links](https://x.y).\n", "bold text and code and links"],
    ["Tom &amp; Jerry \\* stars\n", "& Jerry *"],
    ["one\r\ntwo *three*\r\n", "two three"],
    ["| a | b |\n|---|---|\n| cell one | two |\n", "cell one"],
    ["```ts\nconst a = 1;\nlet b;\n```\n", "a = 1;\nlet"],
    ["- [ ] write tests\n- [x] ship\n", "write tests"],
    ["Text[^n] here.\n\n[^n]: The note.\n", "The note."],
    ['---\ntitle: "Hello world"\n---\n\nBody\n', "Hello world"],
    ["> [!NOTE]\n> Useful info here.\n", "info here"],
    // The generated "MDX" label is selected with the text but not highlighted.
    ["Text {1+1} after\n", "Text MDX{1+1} after", "Text |{1+1} after", { format: "mdx" }],
  ];
  test.each(cases)("%j: %j", (md, needle, runs = needle, options = {}) => {
    const m = mount(md, options);
    expect(highlighted(m, rangeOf(m.article, needle))).toBe(runs);
  });

  test("an expanded selection highlights the whole blocks", () => {
    const m = mount("First para.\n\nSecond para.\n");
    expect(highlighted(m, rangeOf(m.article, "para.\nSecond"))).toBe("First para.\nSecond para.");
  });

  test.each(["rfd-0042-rendered-review.md", "adr-0007-use-postgres.md"])("every word of %s", (name) => {
    const md = readFileSync(`${import.meta.dirname}/../../../../packages/markdown-domain/src/fixtures/${name}`, "utf8");
    const m = mount(md);
    const walker = document.createTreeWalker(m.article, NodeFilter.SHOW_TEXT);
    let checked = 0;
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      if (t.parentElement!.closest("[data-rr-unmapped]:not(:has([data-rr-id]))")) continue;
      for (const word of t.data.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(t, word.index);
        range.setEnd(t, word.index + word[0].length);
        const result = convertRange(m.article, m.rendered, m.source, range);
        if (!result?.ok || result.selection.expanded) continue;
        expect(highlighted(m, range), word[0]).toContain(word[0]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
