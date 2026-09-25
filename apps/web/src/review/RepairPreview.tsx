// SPDX-License-Identifier: AGPL-3.0-only
// Repairing a comment's anchor: what updating the comment on GitHub will change (the quote, the
// document link and the hidden metadata; the reviewer's text shown exactly as it stays), and the
// explicit Update comment / Cancel.
import type { RepairedBody } from "@rendered-review/annotation-domain";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Quote } from "./Composer";
import { ChangeDiff } from "./Markdown";
import { PublishFailure } from "./PublishFailure";

const lines = (text?: string) => (text ? text.split(/\r?\n/) : []);

export interface RepairPreviewProps {
  /** The new selection. */
  selection: SourceSelection;
  /** The comment's body rewritten for the selection; absent when it can't be used (`error` says why). */
  repaired?: RepairedBody;
  error?: string;
  /** Rejects with an Error whose message is shown. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  /** DOM id, for aligning the card with its anchor. */
  id?: string;
}

export function RepairPreview({ selection, repaired, error, onConfirm, onCancel, id }: RepairPreviewProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Error>();
  const region = useRef<HTMLElement>(null);
  useEffect(() => region.current?.focus(), []);

  const confirm = async () => {
    if (!repaired || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await onConfirm();
    } catch (e) {
      setFailure(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // Handled here: the slide-over rail would close on it too.
    event.stopPropagation();
    onCancel();
  };

  return (
    <section
      ref={region}
      id={id}
      className="rr-thread rr-composer"
      aria-label="Repair anchor"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <Quote selection={selection} />
      {error && <p className="rr-composer-error">{error}</p>}
      {repaired && (
        <>
          <p className="rr-composer-note">Updating the comment on GitHub changes only its quote and location:</p>
          <ChangeDiff label="Quote" original={lines(repaired.removed.quote)} proposed={lines(repaired.added.quote)} />
          {repaired.comment && (
            <div className="rr-repair-text" role="group" aria-label="Your comment, unchanged">
              {repaired.comment}
            </div>
          )}
          {(repaired.removed.permalink || repaired.added.permalink) && (
            <ChangeDiff
              label="Document link"
              original={lines(repaired.removed.permalink)}
              proposed={lines(repaired.added.permalink)}
            />
          )}
          <p className="rr-composer-note">The hidden metadata that places the comment is replaced too.</p>
        </>
      )}
      {failure && (
        <p className="rr-composer-error" role="alert">
          <PublishFailure error={failure} />
        </p>
      )}
      <div className="rr-composer-actions">
        <button
          type="button"
          className="rr-btn rr-btn-sm rr-btn-primary"
          disabled={!repaired || busy}
          onClick={() => void confirm()}
        >
          Update comment
        </button>
        <span className="rr-spacer" />
        <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
