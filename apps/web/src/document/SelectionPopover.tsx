// SPDX-License-Identifier: AGPL-3.0-only
// Floating actions for a text selection in the rendered document: Comment (C) and Suggest (S).
import type { RenderedMarkdown, SelectionResult, SourceSelection } from "@rendered-review/markdown-domain";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { convertRange } from "./selection";

const PREVIEW_CHARS = 160;

/** "line 3" or "lines 3–7" for a source claim. */
export const linesLabel = ({ sourceRange: r }: SourceSelection) =>
  r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}–${r.endLine}`;

const truncate = (text: string) => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text);

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Shift+arrow: which way the selection's focus moves, and by what (with Ctrl or Alt: by word or paragraph). */
const EXTEND: Record<string, ["forward" | "backward", "character" | "line", "word" | "paragraph"]> = {
  ArrowRight: ["forward", "character", "word"],
  ArrowLeft: ["backward", "character", "word"],
  ArrowDown: ["forward", "line", "paragraph"],
  ArrowUp: ["backward", "line", "paragraph"],
};

/**
 * Keyboard text selection without caret browsing: Shift+arrows in the document start a selection
 * at the focused element (the first commentable block in view when the document itself has focus) and extend it.
 */
function extendSelection(article: HTMLElement, event: KeyboardEvent) {
  const step = EXTEND[event.key];
  const target = event.target as HTMLElement;
  const selection = document.getSelection();
  if (!step || !selection || !event.shiftKey || event.metaKey || editable(target) || target.closest("[data-rr-ui]"))
    return;
  if (!selection.rangeCount || !article.contains(selection.focusNode)) {
    const top = article.closest(".rr-scroll")?.getBoundingClientRect().top ?? 0;
    const start =
      target === article
        ? ([...article.querySelectorAll("[data-rr-id]")].find(
            // Front matter cannot be commented on.
            (el) => !el.closest(".rr-frontmatter") && el.getBoundingClientRect().top >= top,
          ) ?? article)
        : target;
    selection.collapse(start, 0);
  }
  event.preventDefault();
  selection.modify("extend", step[0], event.ctrlKey || event.altKey ? step[2] : step[1]);
}

/**
 * Shown for a non-empty selection inside `article` after the mouse or keyboard finishes it.
 * Cross-block selections preview the whole blocks they widen to; selections that cannot be
 * commented on say why. C composes a comment and S a suggestion (like the buttons), Escape dismisses
 * and collapses the selection.
 */
export function SelectionPopover({
  article,
  rendered,
  source,
  onCompose,
}: {
  article: HTMLElement | null;
  rendered: RenderedMarkdown;
  source: string;
  /** `suggest`: asked to suggest a change rather than comment. */
  onCompose: (selection: SourceSelection, suggest?: true) => void;
}) {
  const [current, setCurrent] = useState<{ result: SelectionResult; range: Range; rect: DOMRect } | null>(null);
  const previewId = useId();

  const update = useEffectEvent(() => {
    const selection = document.getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
    const result = range && article && convertRange(article, rendered, source, range);
    setCurrent(range && result ? { result, range, rect: range.getBoundingClientRect() } : null);
  });
  useEffect(() => {
    if (!article) return;
    const onDone = () => update();
    const onKeyDown = (event: KeyboardEvent) => extendSelection(article, event);
    article.addEventListener("mouseup", onDone);
    article.addEventListener("keyup", onDone);
    article.addEventListener("keydown", onKeyDown);
    return () => {
      article.removeEventListener("mouseup", onDone);
      article.removeEventListener("keyup", onDone);
      article.removeEventListener("keydown", onKeyDown);
    };
  }, [article]);
  // A new document or render drops a stale selection.
  useEffect(() => setCurrent(null), [rendered]);

  const compose = (selection: SourceSelection, suggest?: true) => {
    setCurrent(null);
    if (suggest) onCompose(selection, suggest);
    else onCompose(selection);
  };
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!current) return;
    if (event.key === "Escape") {
      // Collapsed where it ends: a keyboard reader's next Shift+arrows start there.
      const selection = document.getSelection();
      if (selection?.focusNode) selection.collapse(selection.focusNode, selection.focusOffset);
      setCurrent(null);
    } else if (event.ctrlKey || event.metaKey || event.altKey || editable(event.target)) return;
    else if (/^[cs]$/i.test(event.key) && current.result.ok) {
      event.preventDefault();
      compose(current.result.selection, event.key.toLowerCase() === "s" || undefined);
    }
  });
  const onScroll = useEffectEvent(() => {
    if (current) setCurrent({ ...current, rect: current.range.getBoundingClientRect() });
  });
  useEffect(() => {
    if (!current) return;
    const key = (e: KeyboardEvent) => onKey(e);
    const scroll = () => onScroll();
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [current]);

  if (!current) return null;
  const { result, rect } = current;
  return (
    <div className="rr-sel-pop" style={{ left: rect.left + rect.width / 2, top: rect.top }}>
      {!result.ok ? (
        <p role="status">{result.message}</p>
      ) : (
        <>
          {result.selection.expanded && (
            <p className="rr-sel-preview" id={previewId}>
              Comment covers {linesLabel(result.selection)}: <q>{truncate(result.selection.exact)}</q>
            </p>
          )}
          <div
            role="toolbar"
            aria-label="Selection actions"
            aria-describedby={result.selection.expanded ? previewId : undefined}
          >
            <button
              type="button"
              className="rr-btn rr-btn-sm rr-btn-primary"
              aria-keyshortcuts="C"
              onClick={() => compose(result.selection)}
            >
              Comment <kbd>C</kbd>
            </button>
            <button
              type="button"
              className="rr-btn rr-btn-sm rr-btn-ghost"
              aria-keyshortcuts="S"
              onClick={() => compose(result.selection, true)}
            >
              Suggest <kbd>S</kbd>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
