// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { renderMarkdown } from "@rendered-review/markdown-domain";
import type { ReanchorResult, ThreadPlacement } from "@rendered-review/review-domain";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { lineAnchor, thread } from "../review/fixtures";
import { DEFAULT_FILTERS } from "../review/model";
import { useAnchors } from "./anchors";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (document as Partial<Document>).caretPositionFromPoint;
  returned.length = 0;
});

const source = "# Title\n\nHello brave new world, said the old man.\n\nAnother paragraph.\n\nA reworded one.\n";
const rendered = renderMarkdown(source);
const [first, second, third] = rendered.nodes.filter((n) => n.type === "paragraph");

/** A verified annotation placement on `exact` in `block`. */
const words = (id: string, exact: string, block = first!): ThreadPlacement => {
  const start = source.indexOf(exact);
  const sourceRange = { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 };
  return {
    thread: thread(id, lineAnchor(3)),
    blocks: [block],
    range: {
      kind: "annotation",
      sourceRange,
      textQuote: { exact },
      textPosition: { start, end: start + exact.length },
    },
  };
};
const approximate: ReanchorResult = {
  state: "moved",
  evidence: "structure",
  confidence: 0.5,
  approximate: true,
  candidates: [],
};
const placements: ThreadPlacement[] = [
  words("brave", "brave"),
  words("old", "old man"),
  // A GitHub line comment and a reworded annotation: their blocks, never words.
  { thread: thread("line", lineAnchor(5)), blocks: [second!] },
  { thread: thread("reworded", lineAnchor(7)), blocks: [third!], reanchor: approximate },
];

/** Every distinct ranges map the hook returned, in order. */
const returned: ReadonlyMap<string, Range[]>[] = [];

function Page({ active = null, onActivate = () => {} }: { active?: string | null; onActivate?: (id: string) => void }) {
  const [article, setArticle] = useState<HTMLElement | null>(null);
  const ranges = useAnchors(article, rendered, source, placements, DEFAULT_FILTERS, active, onActivate);
  if (returned.at(-1) !== ranges) returned.push(ranges);
  return (
    <article ref={setArticle} aria-label="Document">
      {toJsxRuntime(rendered.tree, { Fragment, jsx, jsxs })}
    </article>
  );
}

function stubHighlights() {
  const highlights = new Map<string, { ranges: Range[] }>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    },
  );
  return {
    highlights,
    text: (name: string) => highlights.get(name)?.ranges.map((r) => r.toString()) ?? [],
  };
}

const block = (text: string) => screen.getByText(text, { exact: false, selector: "p" });

it("highlights exactly each verified annotation's words; line comments and reworded text keep their blocks", () => {
  const { text } = stubHighlights();
  render(<Page />);
  expect(text("rr-comment")).toEqual(["brave", "old man"]);
  expect(text("rr-comment-active")).toEqual([]);
  expect(block("Hello brave").hasAttribute("data-rr-words")).toBe(true);
  for (const p of ["Another paragraph", "A reworded one"]) {
    expect(block(p).hasAttribute("data-rr-anchor")).toBe(true);
    expect(block(p).hasAttribute("data-rr-words")).toBe(false);
  }
  // Every anchor stays keyboard operable.
  for (const p of ["Hello brave", "Another paragraph", "A reworded one"]) expect(block(p).tabIndex).toBe(0);
});

it("moves the active thread's words to the active highlight", () => {
  const { text } = stubHighlights();
  const { rerender } = render(<Page />);
  rerender(<Page active="old" />);
  expect(text("rr-comment")).toEqual(["brave"]);
  expect(text("rr-comment-active")).toEqual(["old man"]);
});

it("does not re-render for document changes that leave the words where they were", async () => {
  stubHighlights();
  render(<Page />);
  const before = returned.length;
  screen.getByRole("article").append(document.createComment("unrelated"));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(returned.length).toBe(before);
});

it("removes its highlights when unmounted", () => {
  const { highlights } = stubHighlights();
  const { unmount } = render(<Page active="old" />);
  unmount();
  expect([...highlights.keys()]).toEqual([]);
});

it("activates the thread whose words were clicked, among two in one block", () => {
  stubHighlights();
  const onActivate = vi.fn();
  render(<Page onActivate={onActivate} />);
  const paragraph = block("Hello brave");
  const textNode = paragraph.firstChild!;
  const caretAt = (offset: number) =>
    Object.assign(document, { caretPositionFromPoint: () => ({ offsetNode: textNode, offset }) });

  caretAt(source.indexOf("man") - source.indexOf("Hello"));
  fireEvent.click(paragraph);
  expect(onActivate).toHaveBeenLastCalledWith("old");

  caretAt(source.indexOf("brave") - source.indexOf("Hello") + 1);
  fireEvent.click(paragraph);
  expect(onActivate).toHaveBeenLastCalledWith("brave");

  // Outside every highlighted word: the block's first thread.
  caretAt(1);
  fireEvent.click(paragraph);
  expect(onActivate).toHaveBeenLastCalledWith("brave");
});

it("without the CSS Custom Highlight API, highlights whole blocks instead", () => {
  render(<Page />);
  expect(block("Hello brave").hasAttribute("data-rr-anchor")).toBe(true);
  expect(block("Hello brave").hasAttribute("data-rr-words")).toBe(false);
});
