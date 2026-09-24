// SPDX-License-Identifier: AGPL-3.0-only
// Comment anchors in the rendered document: the blocks threads point at, and the exact words of verified annotations.
import type { RenderedMarkdown } from "@rendered-review/markdown-domain";
import type { ThreadPlacement } from "@rendered-review/review-domain";
import { useEffect, useEffectEvent } from "react";
import { threadState, type ThreadState } from "../review/model";
import { threadDomId } from "../review/ThreadCard";
import { nodeElement } from "./document";

/**
 * Marks the rendered blocks of visible threads: `aria-details` points at their cards, and
 * `data-rr-anchor` / `data-rr-active` drive the highlight. Clicking a block, or Enter/Space on it,
 * activates its thread. Attributes are set on React-rendered elements, so they are removed again
 * before every update.
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
      onActivate(threads[0]!.id);
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
        el.removeAttribute("tabindex");
      }
    };
  }, [article, placements, filters, activeId]);
}
