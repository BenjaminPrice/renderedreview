// SPDX-License-Identifier: AGPL-3.0-only
// The comment composer card in the rail: quote of the selection, Markdown comment box with
// preview, where the comment will post, and Add to review / Comment now / Cancel.
import type { SourceSelection } from "@rendered-review/markdown-domain";
import type { Representation } from "@rendered-review/review-domain";
import { useId, useState, type KeyboardEvent } from "react";
import { linesLabel } from "../document/SelectionPopover";
import { Markdown } from "./Markdown";

const QUOTE_CHARS = 280;

export interface ComposerProps {
  selection: SourceSelection;
  representation: Representation;
  /** Why this selection cannot be commented on (e.g. too long); nothing can be saved. */
  error?: string;
  signedIn: boolean;
  /** Starts sign-in; without it, signed-out readers are told commenting needs sign-in. */
  onSignIn?: () => void;
  /** Editing an existing draft: starts from its text, saves instead of adding, no Comment now. */
  initial?: string;
  editing?: boolean;
  onAddToReview: (comment: string) => void;
  /** Rejects with an Error whose message is shown; the text is kept. */
  onCommentNow: (comment: string) => Promise<void>;
  onCancel: () => void;
  /** DOM id, for aligning the card with its anchor. */
  id?: string;
}

/** "Will post as X · why" with the representation in bold. */
export function RepresentationHint({ representation, id }: { representation: Representation; id?: string }) {
  const [what, ...why] = representation.reason.split(" · ");
  return (
    <p className="rr-hint" id={id}>
      <svg className="rr-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 7.5v3.5M8 5v.2" />
      </svg>
      <span>
        <b>{what}</b>
        {why.length > 0 && ` · ${why.join(" · ")}`}
      </span>
    </p>
  );
}

export function Quote({ selection }: { selection: SourceSelection }) {
  const text = selection.exact;
  return (
    <>
      <blockquote className="rr-pending-quote">
        {text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text}
      </blockquote>
      {selection.expanded && <p className="rr-composer-note">Comment covers {linesLabel(selection)} · whole blocks</p>}
    </>
  );
}

export function Composer(props: ComposerProps) {
  const { selection, representation, error, signedIn, editing } = props;
  const [text, setText] = useState(props.initial ?? "");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const ids = { text: useId(), hint: useId() };
  const blank = !text.trim();
  const canSave = !error && !blank && !busy;

  const add = () => canSave && props.onAddToReview(text);
  const cancel = () => {
    if (text.trim() === (props.initial ?? "").trim() || confirm("Discard this comment?")) props.onCancel();
  };
  const commentNow = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await props.onCommentNow(text);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Handled here: the slide-over rail would close on it too.
      event.stopPropagation();
      cancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      add();
    }
  };

  return (
    <section
      id={props.id}
      className="rr-thread rr-composer"
      aria-label={editing ? "Edit draft" : "New comment"}
      onKeyDown={onKeyDown}
    >
      <div className="rr-composer-top">
        <div className="rr-seg" role="group" aria-label="Comment type">
          <button type="button" aria-pressed="true">
            Comment
          </button>
          <button type="button" aria-pressed="false" aria-disabled="true" title="Suggestions are coming soon">
            Suggest
          </button>
        </div>
        <span className="rr-spacer" />
        {signedIn && (
          <button
            type="button"
            className="rr-btn rr-btn-sm rr-btn-ghost"
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            Preview
          </button>
        )}
      </div>
      <Quote selection={selection} />
      {!signedIn ? (
        <div className="rr-composer-actions">
          {props.onSignIn ? (
            <button type="button" className="rr-btn rr-btn-sm rr-btn-primary" onClick={props.onSignIn}>
              Sign in to comment
            </button>
          ) : (
            <span className="rr-composer-note">Commenting needs GitHub sign-in, which this server doesn't offer.</span>
          )}
          <span className="rr-spacer" />
          <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          {preview ? (
            <div className="rr-composer-preview">
              {blank ? <p className="rr-composer-note">Nothing to preview.</p> : <Markdown source={text} />}
            </div>
          ) : (
            <>
              <label className="rr-sr-only" htmlFor={ids.text}>
                Comment
              </label>
              <textarea
                id={ids.text}
                className="rr-composer-text"
                autoFocus
                value={text}
                placeholder="Leave a comment (Markdown)"
                aria-describedby={ids.hint}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                onChange={(e) => setText(e.target.value)}
              />
            </>
          )}
          {(error ?? failure) && (
            <p className="rr-composer-error" role="alert">
              {error ?? failure}
            </p>
          )}
          <RepresentationHint representation={representation} id={ids.hint} />
          <div className="rr-composer-actions">
            <button type="button" className="rr-btn rr-btn-sm rr-btn-primary" disabled={!canSave} onClick={add}>
              {editing ? "Save draft" : "Add to review"}
            </button>
            {!editing && (
              <button type="button" className="rr-btn rr-btn-sm" disabled={!canSave} onClick={() => void commentNow()}>
                Comment now
              </button>
            )}
            <span className="rr-spacer" />
            <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
