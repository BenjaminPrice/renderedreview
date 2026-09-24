// SPDX-License-Identifier: AGPL-3.0-only
// Comment anchors in the rendered document: the blocks threads point at, and the exact words of verified annotations.
import type { RenderedMarkdown } from "@rendered-review/markdown-domain";
import type { ThreadPlacement } from "@rendered-review/review-domain";
import { useEffect, useEffectEvent, useState } from "react";
import { threadState, type ThreadState } from "../review/model";
import { threadDomId } from "../review/ThreadCard";
import { nodeElement } from "./document";
import { highlightsSupported } from "./highlight";
import { highlightRanges } from "./selection";

const NAMES = ["rr-comment", "rr-comment-resolved", "rr-comment-active"] as const;
const NONE: ReadonlyMap<string, Range[]> = new Map();

const sameRange = (a: Range, b: Range) =>
  a.startContainer === b.startContainer &&
  a.startOffset === b.startOffset &&
  a.endContainer === b.endContainer &&
  a.endOffset === b.endOffset;

/** Whether two ranges maps cover the same DOM positions, so nothing needs repainting. */
function sameRanges(a: ReadonlyMap<string, Range[]>, b: ReadonlyMap<string, Range[]>) {
  if (a.size !== b.size) return false;
  for (const [id, rs] of b) {
    const old = a.get(id);
    if (old?.length !== rs.length || rs.some((r, i) => !sameRange(r, old[i]!))) return false;
  }
  return true;
}

/** Where a click landed in the text, if the browser can tell. */
function caretAt(x: number, y: number): [Node, number] | null {
  const p = document.caretPositionFromPoint?.(x, y);
  if (p) return [p.offsetNode, p.offset];
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? [r.startContainer, r.startOffset] : null;
}

/**
 * Marks the rendered blocks of visible threads: `aria-details` points at their cards, and
 * `data-rr-anchor` / `data-rr-active` drive the highlight. Clicking a block, or Enter/Space on it,
 * activates its thread. Attributes are set on React-rendered elements, so they are removed again
 * before every update.
 *
 * Verified annotations (placements with a `range`) highlight exactly their words with the CSS Custom
 * Highlight API (`::highlight(rr-comment)`, `-resolved`, `-active`); blocks whose threads all do so get
 * `data-rr-words` instead of the whole-block highlight, and a click on the words activates their
 * thread. Without the API every thread keeps its block highlight. Returns each thread's word ranges.
 */
export function useAnchors(
  article: HTMLElement | null,
  rendered: RenderedMarkdown | undefined,
  source: string | undefined,
  placements: ThreadPlacement[],
  filters: ReadonlySet<ThreadState>,
  activeId: string | null,
  activate: (threadId: string) => void,
) {
  const onActivate = useEffectEvent(activate);
  const [ranges, setRanges] = useState(NONE);
  useEffect(() => {
    if (!article || !rendered || source === undefined || !highlightsSupported()) return setRanges(NONE);
    const measure = () => {
      const next = new Map(
        placements.flatMap(({ thread, range }) => {
          if (!range || !filters.has(threadState(thread))) return [];
          const found = highlightRanges(article, rendered, source, range.textPosition);
          return found.length ? [[thread.id, found] as const] : [];
        }),
      );
      setRanges((prev) => (sameRanges(prev, next) ? prev : next));
    };
    measure();
    // Re-rendered document parts (a diagram's source view, lazy content) invalidate the ranges.
    const observer = new MutationObserver(measure);
    observer.observe(article, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [article, rendered, source, placements, filters]);

  useEffect(() => {
    if (!ranges.size) return;
    const resolved = new Set(placements.filter((p) => threadState(p.thread) === "resolved").map((p) => p.thread.id));
    const named = Object.fromEntries(NAMES.map((n) => [n, [] as Range[]]));
    for (const [id, r] of ranges)
      named[id === activeId ? "rr-comment-active" : resolved.has(id) ? "rr-comment-resolved" : "rr-comment"]!.push(
        ...r,
      );
    for (const name of NAMES) CSS.highlights.set(name, new Highlight(...named[name]!));
    return () => NAMES.forEach((name) => CSS.highlights.delete(name));
  }, [ranges, placements, activeId]);

  useEffect(() => {
    if (!article) return;
    const threadsOf = new Map<HTMLElement, ThreadPlacement["thread"][]>();
    for (const { thread, blocks } of placements) {
      if (!filters.has(threadState(thread))) continue;
      for (const block of blocks) {
        const el = nodeElement(article, block.id);
        if (el) threadsOf.set(el, [...(threadsOf.get(el) ?? []), thread]);
      }
    }
    for (const [el, threads] of threadsOf) {
      el.setAttribute("aria-details", threads.map((t) => threadDomId(t.id)).join(" "));
      el.dataset.rrAnchor = threadState(threads[0]!);
      if (threads.some((t) => t.id === activeId)) el.dataset.rrActive = "";
      if (threads.every((t) => ranges.has(t.id))) el.dataset.rrWords = "";
      el.tabIndex = 0;
    }
    const handle = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const anchor = target.closest<HTMLElement>("[data-rr-anchor]");
      const threads = anchor && threadsOf.get(anchor);
      if (!threads) return;
      if (event instanceof KeyboardEvent) {
        if (target !== anchor || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
      } else if (target.closest("a, button, summary, input")) return; // links inside keep working
      // Clicked words activate their thread; elsewhere in the block, its first thread.
      const caret = event instanceof MouseEvent ? caretAt(event.clientX, event.clientY) : null;
      const hit = caret && threads.find((t) => ranges.get(t.id)?.some((r) => r.isPointInRange(...caret)));
      onActivate((hit ?? threads[0]!).id);
    };
    article.addEventListener("click", handle);
    article.addEventListener("keydown", handle);
    return () => {
      article.removeEventListener("click", handle);
      article.removeEventListener("keydown", handle);
      for (const el of threadsOf.keys()) {
        el.removeAttribute("aria-details");
        el.removeAttribute("data-rr-anchor");
        el.removeAttribute("data-rr-active");
        el.removeAttribute("data-rr-words");
        el.removeAttribute("tabindex");
      }
    };
  }, [article, placements, filters, activeId, ranges]);
  return ranges;
}
