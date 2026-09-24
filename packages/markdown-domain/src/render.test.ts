// SPDX-License-Identifier: AGPL-3.0-only
import type { Element, Nodes, Root } from "hast";
import { toHtml } from "hast-util-to-html";
import { describe, expect, test } from "vitest";
import adr from "./fixtures/adr-0007-use-postgres.md?raw";
import rfd from "./fixtures/rfd-0042-rendered-review.md?raw";
import xss from "./fixtures/xss.md?raw";
import { normalizeText } from "./normalize.js";
import { blocksForLines, renderMarkdown, type SourcePoint, type SourceRange } from "./render.js";

const fixtures = { adr, rfd, xss };

/** Offset of a 1-based line/column, computed independently of the parser. */
function offsetOf(source: string, { line, column }: SourcePoint): number {
  let offset = 0;
  for (let l = 1; l < line; l++) offset = source.indexOf("\n", offset) + 1;
  return offset + column - 1;
}

function expectValidRange(source: string, range: SourceRange) {
  expect(range.start.offset).toBeGreaterThanOrEqual(0);
  expect(range.end.offset).toBeLessThanOrEqual(source.length);
  expect(range.start.offset).toBeLessThanOrEqual(range.end.offset);
  expect(offsetOf(source, range.start)).toBe(range.start.offset);
  expect(offsetOf(source, range.end)).toBe(range.end.offset);
}

/** Text the pipeline generates without source (footnote chrome and reference numbers). */
const GENERATED_TEXT = new Set(["Footnotes", "↩", "1"]);

describe.each(Object.entries(fixtures))("%s fixture", (name, source) => {
  const doc = renderMarkdown(source);

  test("renders to the reviewed snapshot", async () => {
    await expect(toHtml(doc.tree)).toMatchFileSnapshot(`./fixtures/${name}.html`);
  });

  test("every side-table node has a valid range and matching element", () => {
    const seen: number[] = [];
    const visit = (node: Nodes) => {
      if (node.type === "element" && node.properties.dataRrId !== undefined) {
        const entry = doc.nodes[node.properties.dataRrId as number]!;
        expect(entry.tagName).toBe(node.tagName);
        expectValidRange(source, entry.range);
        seen.push(entry.id);
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(doc.tree);
    expect(seen).toEqual(doc.nodes.map((n) => n.id));
  });

  // A text node belongs to its own position or, failing that, to its nearest stamped ancestor:
  // a `data-rr-id` ancestor gives the range, a `data-rr-unmapped` one makes it non-selectable.
  test("every rendered text node maps to a source range containing it", () => {
    const visit = (node: Nodes, owner: SourceRange | null) => {
      if (node.type === "text" && node.value.trim()) {
        const range = node.position ? { start: node.position.start, end: node.position.end } : owner;
        if (!range) {
          expect(GENERATED_TEXT, `unmapped text ${JSON.stringify(node.value)}`).toContain(node.value);
        } else {
          expectValidRange(source, range as SourceRange);
          const slice = normalizeText(source.slice(range.start.offset, range.end.offset));
          // trim(): remark-rehype appends a space to the text before a footnote back-reference.
          if (!GENERATED_TEXT.has(node.value)) expect(slice).toContain(normalizeText(node.value.trim()));
        }
      }
      if (node.type === "element") {
        const id = node.properties.dataRrId;
        owner = id === undefined ? null : doc.nodes[id as number]!.range;
      }
      if ("children" in node) for (const c of node.children) visit(c, owner);
    };
    visit(doc.tree, null);
  });

  test("is deterministic", () => {
    expect(renderMarkdown(source)).toEqual(doc);
  });
});

describe("rfd fixture mapping", () => {
  const doc = renderMarkdown(rfd);
  const line = (n: number) => rfd.split("\n")[n - 1];

  test("heading paths follow the section outline", () => {
    const dataFlow = doc.nodes.find((n) => n.type === "code")!;
    expect(dataFlow.headingPath).toEqual(["RFD 42: Rendered review for Markdown documents", "Proposal", "Data flow"]);
    const openQuestions = doc.nodes.find((n) => n.text === "Open questions")!;
    expect(openQuestions.headingPath).toEqual(["RFD 42: Rendered review for Markdown documents", "Open questions"]);
  });

  test("fenced code keeps its language and the full fence range", () => {
    const fence = doc.nodes.find((n) => n.lang === "mermaid")!;
    expect(fence.tagName).toBe("pre");
    expect(line(fence.range.start.line)).toBe("```mermaid");
    expect(line(fence.range.end.line)).toBe("```");
    expect(fence.range.end.column).toBe(4);
  });

  test("line comments resolve to the innermost blocks", () => {
    const at = (s: number, e = s) => blocksForLines(doc, s, e).map((n) => `${n.type}:${n.text}`);
    const fenceLine = rfd.split("\n").indexOf("  Reviewer->>Browser: select text") + 1;
    expect(blocksForLines(doc, fenceLine, fenceLine).map((n) => [n.tagName, n.lang])).toEqual([["pre", "mermaid"]]);

    const rowLine = rfd.split("\n").findIndex((l) => l.startsWith("| Rendered review")) + 1;
    expect(at(rowLine)).toEqual(["tableRow:Rendered reviewcharacterparser"]);

    expect(at(3, 5)).toEqual(["heading:Background", expect.stringMatching(/^paragraph:Reviewing prose/)]);
    expect(at(4)).toEqual([]);
  });

  test("inline HTML does not displace its paragraph", () => {
    const doc = renderMarkdown("Press <kbd>Ctrl</kbd>.\n\n<details>\n<summary>More</summary>\n\nBody\n\n</details>\n");
    const at = (l: number) => blocksForLines(doc, l, l).map((n) => `${n.type}:${n.tagName}`);
    expect(at(1)).toEqual(["paragraph:p"]);
    expect(at(4)).toEqual(["html:summary"]);
    expect(at(6)).toEqual(["paragraph:p"]);
  });
});

describe("GitHub Flavored Markdown", () => {
  const html = (md: string) =>
    toHtml(renderMarkdown(md).tree)
      .trim()
      .replace(/ data-rr-(id="\d+"|unmapped)/g, "");

  test("tables with alignment", () => {
    expect(html("| a | b |\n| :- | -: |\n| 1 | 2 |")).toBe(
      '<table><thead><tr><th align="left">a</th><th align="right">b</th></tr></thead><tbody><tr><td align="left">1</td><td align="right">2</td></tr></tbody></table>',
    );
  });

  test("task lists", () => {
    expect(html("- [ ] todo\n- [x] done")).toBe(
      '<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" disabled> todo</li>\n<li class="task-list-item"><input type="checkbox" checked disabled> done</li>\n</ul>',
    );
  });

  test("strikethrough and autolinks", () => {
    expect(html("~~old~~ www.example.com https://a.test <https://b.test> me@c.test")).toBe(
      '<p><del>old</del> <a href="http://www.example.com">www.example.com</a> <a href="https://a.test">https://a.test</a> <a href="https://b.test">https://b.test</a> <a href="mailto:me@c.test">me@c.test</a></p>',
    );
  });

  test("footnotes use GitHub's ids", () => {
    const out = html("Claim.[^a]\n\n[^a]: Source.");
    expect(out).toContain('<a href="#fn-a" id="user-content-fnref-a" data-footnote-ref');
    expect(out).toContain('<li id="user-content-fn-a">');
    expect(out).toContain('<a href="#fnref-a" data-footnote-backref=""');
  });

  test("permitted HTML survives", () => {
    expect(html("<kbd>Ctrl</kbd> H<sub>2</sub>O")).toBe("<p><kbd>Ctrl</kbd> H<sub>2</sub>O</p>");
  });
});

describe("sanitization", () => {
  const doc = renderMarkdown(xss);
  const out = toHtml(doc.tree);

  const elements: Element[] = [];
  const collect = (node: Root | Element) =>
    node.children.forEach((c) => c.type === "element" && (elements.push(c), collect(c)));
  collect(doc.tree);

  test("no active or embedding elements survive", () => {
    const banned = ["script", "style", "iframe", "svg", "math", "object", "embed", "form", "base", "meta", "link"];
    expect(elements.map((e) => e.tagName).filter((t) => banned.includes(t))).toEqual([]);
  });

  test("no event handlers, inline styles or unsafe URLs survive", () => {
    for (const { properties } of elements) {
      for (const [name, value] of Object.entries(properties)) {
        expect(name).not.toMatch(/^on|^style$/i);
        if (name === "href" || name === "src") expect(String(value)).toMatch(/^(https?:|mailto:|#|[^:]*$)/i);
      }
    }
  });

  test("markup smuggled as text stays text", () => {
    expect(out).toContain("&#x3C;img src=x onerror=");
  });

  test("author ids are prefixed and forged markers are replaced", () => {
    const p = doc.nodes.find((n) => n.text === "clobber and forged markers")!;
    const el = elements.find((e) => e.properties.dataRrId === p.id)!;
    expect(el.properties).toEqual({ id: "user-content-__proto__", name: "user-content-location", dataRrId: p.id });
    expect(p.id).not.toBe(0);
  });
});

test("CRLF sources keep line numbers and raw offsets", () => {
  const lf = renderMarkdown("# A\n\nText *here*\n");
  const crlf = renderMarkdown("# A\r\n\r\nText *here*\r\n");
  expect(crlf.nodes.map((n) => [n.type, n.range.start.line, n.range.start.column, n.text])).toEqual(
    lf.nodes.map((n) => [n.type, n.range.start.line, n.range.start.column, n.text]),
  );
  expect(crlf.nodes.find((n) => n.type === "emphasis")!.range.start.offset).toBe(12);
});
