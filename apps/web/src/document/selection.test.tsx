// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// DOM selection <-> source claims on the real rendered article, and the round trip back to a highlight.
import { readFileSync } from "node:fs";
import { createDiagramRegistry } from "@rendered-review/diagram-domain";
import { renderMarkdown, type RenderOptions } from "@rendered-review/markdown-domain";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { DiagramRegistryContext } from "../diagram/registry";
import { renderWithRouter } from "../test-utils";
import { RenderedDocument } from "./document";
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
    const hit = texts.filter(([t, from]) => (end ? from < g : from <= g) && g <= from + t.length).at(-1)!;
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

describe("diagram fences", () => {
  const DOC = "# Flow\n\n```mermaid\nflowchart LR\n  title Delivery flow\n  A --> B\n```\n\nAfter.\n";
  const registry = createDiagramRegistry([
    {
      label: "Mermaid",
      fenceNames: ["mermaid"],
      load: async () => ({
        id: "fake",
        fenceNames: ["mermaid"],
        version: "1",
        render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>' }),
      }),
    },
  ]);
  const LINK = { host: "github.com", owner: "o", repo: "r", sha: "abc", path: "flow.md" };

  async function mountDiagram(source = DOC): Promise<Mounted> {
    const rendered = renderMarkdown(source);
    const { container } = await renderWithRouter(() => (
      <DiagramRegistryContext value={registry}>
        <RenderedDocument rendered={rendered} changes={[]} link={LINK} blobOid="blob" />
      </DiagramRegistryContext>
    ));
    await screen.findByRole("img", { name: /Mermaid diagram/ });
    return { rendered, source, article: container.querySelector("article")! };
  }
  const figure = () => screen.getByRole("figure");
  const showSource = () => userEvent.click(within(figure()).getByRole("button", { name: "Source" }));
  const claimed = (m: Mounted, range: Range) => {
    const s = convert(m, range);
    return m.source.slice(s.textPosition.start, s.textPosition.end);
  };

  test("a selection in the toolbar only is rejected as generated", async () => {
    const m = await mountDiagram();
    const result = convertRange(m.article, m.rendered, m.source, rangeOf(m.article, "Copy source"));
    expect(result).toMatchObject({ ok: false, reason: "generated" });
  });

  test("a selection from document text into the toolbar clamps to the document text", async () => {
    const m = await mountDiagram();
    const range = rangeOf(m.article, "Flow");
    range.setEnd(within(figure()).getByRole("button", { name: "Copy source" }).firstChild!, 4);
    expect(convert(m, range)).toMatchObject({ exact: "Flow", expanded: false });
  });

  test("a selection in the source view maps to exactly those fence source characters", async () => {
    const m = await mountDiagram();
    await showSource();
    const s = convert(m, rangeOf(m.article, "A --> B"));
    expect(m.source.slice(s.textPosition.start, s.textPosition.end)).toBe("A --> B");
    expect(s.sourceRange).toMatchObject({ startLine: 6, endLine: 6 });
  });

  test("line numbers inside a source view selection are not claimed", async () => {
    const m = await mountDiagram();
    await showSource();
    expect(claimed(m, rangeOf(m.article, "flow\n6  A"))).toBe("flow\n  A");
  });

  test("a claim inside the fence highlights its text in the open source view", async () => {
    const m = await mountDiagram();
    await showSource();
    expect(highlighted(m, rangeOf(m.article, "Delivery flow\n6  A"))).toBe("Delivery flow\n6  A");
  });

  test("a claim inside the fence highlights the whole diagram while the source view is closed", async () => {
    const m = await mountDiagram();
    await showSource();
    const claim = convert(m, rangeOf(m.article, "A --> B")).textPosition;
    await showSource();
    const ranges = highlightRanges(m.article, m.rendered, m.source, claim);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.startContainer).toBe(figure());
    expect(ranges[0]!.startOffset).toBe(0);
    expect(ranges[0]!.endContainer).toBe(figure());
    expect(ranges[0]!.endOffset).toBe(figure().childNodes.length);
  });
});
