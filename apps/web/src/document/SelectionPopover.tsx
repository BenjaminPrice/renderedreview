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

/**
 * Shown for a non-empty selection inside `article` after the mouse or keyboard finishes it.
 * Cross-block selections preview the whole blocks they widen to; selections that cannot be
 * commented on say why. C composes a comment (like the button), Escape dismisses.
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
  onCompose: (selection: SourceSelection) => void;
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
    article.addEventListener("mouseup", onDone);
    article.addEventListener("keyup", onDone);
    return () => {
      article.removeEventListener("mouseup", onDone);
      article.removeEventListener("keyup", onDone);
    };
  }, [article]);
  // A new document or render drops a stale selection.
  useEffect(() => setCurrent(null), [rendered]);

  const compose = (selection: SourceSelection) => {
    setCurrent(null);
    onCompose(selection);
  };
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!current) return;
    if (event.key === "Escape") setCurrent(null);
    else if (event.ctrlKey || event.metaKey || event.altKey || editable(event.target)) return;
    else if (event.key.toLowerCase() === "c" && current.result.ok) {
      event.preventDefault();
      compose(current.result.selection);
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
              aria-disabled="true"
              title="Suggestions are not available yet"
            >
              Suggest <kbd>S</kbd>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Placeholder for the comment being composed on `selection`, until the composer exists. */
export function PendingComment({ selection, onCancel }: { selection: SourceSelection; onCancel: () => void }) {
  return (
    <section className="rr-thread rr-pending" aria-label="New comment">
      <blockquote className="rr-pending-quote">{truncate(selection.exact)}</blockquote>
      <p className="rr-pending-note">Writing comments is coming soon.</p>
      <div className="rr-t-foot">
        <span className="rr-t-loc">
          Source {linesLabel(selection)}
          {selection.expanded && " · whole blocks"}
        </span>
        <span className="rr-spacer" />
        <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
