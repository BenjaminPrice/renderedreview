// SPDX-License-Identifier: AGPL-3.0-only
// Highlights the selection a comment is being written on, without touching the document's text.
import type { RenderedMarkdown, SourceSelection } from "@rendered-review/markdown-domain";
import { useEffect } from "react";
import { nodeElement } from "./document";
import { highlightRanges } from "./selection";

const NAME = "rr-pending";

/**
 * Highlights exactly `selection`'s text with the CSS Custom Highlight API (styled by
 * `::highlight(rr-pending)`). Where the API is missing, marks its blocks with `data-rr-pending`
 * instead. Either way no inline styles and no DOM text changes.
 */
export function usePendingHighlight(
  article: HTMLElement | null,
  rendered: RenderedMarkdown | undefined,
  source: string | undefined,
  selection: SourceSelection | undefined,
) {
  useEffect(() => {
    if (!article || !rendered || source === undefined || !selection) return;
    if (typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined") {
      CSS.highlights.set(NAME, new Highlight(...highlightRanges(article, rendered, source, selection.textPosition)));
      return () => void CSS.highlights.delete(NAME);
    }
    const blocks = selection.blockIds.flatMap((id) => nodeElement(article, id) ?? []);
    for (const el of blocks) el.dataset.rrPending = "";
    return () => {
      for (const el of blocks) delete el.dataset.rrPending;
    };
  }, [article, rendered, source, selection]);
}
