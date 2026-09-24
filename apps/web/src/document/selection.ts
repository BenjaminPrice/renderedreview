// SPDX-License-Identifier: AGPL-3.0-only
// DOM adapter for selection conversion: DOM boundary points <-> rendered points (stamped element + text offset).
import {
  type RenderedMarkdown,
  type RenderedPoint,
  selectionToSource,
  type SelectionResult,
  sourceToRendered,
} from "@rendered-review/markdown-domain";
import { nodeElement } from "./document";

const STAMPED = "[data-rr-id]";

const idOf = (el: Element) => Number(el.getAttribute("data-rr-id"));

/**
 * The rendered point for a DOM boundary point in `article`: its nearest stamped ancestor and the
 * text length before it there. A boundary outside every stamped element (between blocks) moves to
 * the nearest stamped element after it (`start`) or before it (`end`).
 */
function pointOf(article: HTMLElement, node: Node, offset: number, edge: "start" | "end"): RenderedPoint | null {
  const el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(STAMPED);
  if (el && article.contains(el)) {
    const before = document.createRange();
    before.setStart(el, 0);
    before.setEnd(node, offset);
    return { id: idOf(el), offset: before.toString().length };
  }
  const step = edge === "start" ? 1 : -1;
  for (;;) {
    const kids = node.childNodes;
    for (let i = edge === "start" ? offset : offset - 1; i >= 0 && i < kids.length; i += step) {
      const kid = kids[i]!;
      if (kid.nodeType !== Node.ELEMENT_NODE) continue;
      const found = (kid as Element).matches(STAMPED)
        ? (kid as Element)
        : edge === "start"
          ? (kid as Element).querySelector(STAMPED)
          : [...(kid as Element).querySelectorAll(STAMPED)].at(-1);
      if (found) return { id: idOf(found), offset: edge === "start" ? 0 : found.textContent.length };
    }
    if (node === article || !node.parentNode) return null;
    offset = [...node.parentNode.childNodes].indexOf(node as ChildNode) + (edge === "start" ? 1 : 0);
    node = node.parentNode;
  }
}

/** Convert a DOM range inside `article` into a source claim; null when it is not inside the article. */
export function convertRange(
  article: HTMLElement,
  rendered: RenderedMarkdown,
  source: string,
  range: Range,
): SelectionResult | null {
  if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
  const start = pointOf(article, range.startContainer, range.startOffset, "start");
  const end = pointOf(article, range.endContainer, range.endOffset, "end");
  return start && end ? selectionToSource(rendered, source, start, end) : null;
}

/** The DOM position of a rendered point: inside the text node holding the next (`start`) or previous (`end`) character. */
function domPosition(article: HTMLElement, p: RenderedPoint, edge: "start" | "end"): [Node, number] | null {
  const el = nodeElement(article, p.id);
  if (!el) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (edge === "start" ? p.offset < seen + t.length : p.offset <= seen + t.length) return [t, p.offset - seen];
    seen += t.length;
    last = t;
  }
  return last ? [last, last.length] : [el, 0];
}

/** DOM ranges for the rendered text a source claim covers (raw offsets, `end` exclusive), e.g. to highlight a comment's quote. */
export function highlightRanges(
  article: HTMLElement,
  rendered: RenderedMarkdown,
  source: string,
  claim: { start: number; end: number },
): Range[] {
  return sourceToRendered(rendered, source, claim).flatMap((run) => {
    const a = domPosition(article, run.start, "start");
    const b = domPosition(article, run.end, "end");
    if (!a || !b) return [];
    const range = document.createRange();
    range.setStart(...a);
    range.setEnd(...b);
    return [range];
  });
}
