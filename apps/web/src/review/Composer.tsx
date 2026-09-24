// SPDX-License-Identifier: AGPL-3.0-only
// The comment composer card in the rail: quote of the selection, Markdown comment box with
// preview, where the comment will post, and Add to review / Comment now / Cancel. The Suggest tab
// proposes a replacement for the selected source lines instead, with a live diff.
import type { SourceSelection } from "@rendered-review/markdown-domain";
import { suggestionEligible, type Representation } from "@rendered-review/review-domain";
import { useId, useState, type KeyboardEvent } from "react";
import { linesLabel } from "../document/SelectionPopover";
import { selectedLines } from "./compose";
import { ChangeDiff, Markdown } from "./Markdown";

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
  /** The whole source lines the selection covers. Suggesting needs them. */
  original?: string;
  /** Opens on the Suggest tab. */
  suggest?: boolean;
  /** Editing a suggestion draft: its replacement (opens on the Suggest tab). */
  initialReplacement?: string;
  /** `replacement` is given for a suggestion, absent for a plain comment. */
  onAddToReview: (comment: string, replacement?: string) => void;
  /** Rejects with an Error whose message is shown; the text is kept. */
  onCommentNow: (comment: string, replacement?: string) => Promise<void>;
  onCancel: () => void;
  /** DOM id, for aligning the card with its anchor. */
  id?: string;
}

/** How a suggestion with `representation` will post. */
export const suggestionReason = (representation: Representation) =>
  suggestionEligible(representation)
    ? "Will post as a native suggestion · authors can apply it on GitHub"
    : "Will post as a proposed change · it must be applied manually";

/** "Will post as X · why" with the representation in bold. */
export function RepresentationHint({
  representation,
  id,
}: {
  representation: Pick<Representation, "reason">;
  id?: string;
}) {
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
  const original = props.original;
  const canSuggest = signedIn && original !== undefined;
  const [suggesting, setSuggesting] = useState(
    canSuggest && (!!props.suggest || props.initialReplacement !== undefined),
  );
  const startReplacement = props.initialReplacement ?? original ?? "";
  const [replacement, setReplacement] = useState(startReplacement);
  const [text, setText] = useState(props.initial ?? "");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const ids = { text: useId(), hint: useId(), replacement: useId(), lines: useId() };
  const blank = !text.trim();
  const unchanged = suggesting && replacement === original;
  const canSave = !error && !busy && (suggesting ? !unchanged : !blank);
  // A suggestion's replacement goes with it; a plain comment has none.
  const args = (): [string, string?] => (suggesting ? [text, replacement] : [text]);

  const add = () => canSave && props.onAddToReview(...args());
  const cancel = () => {
    const untouched = text.trim() === (props.initial ?? "").trim() && replacement === startReplacement;
    if (untouched || confirm("Discard this comment?")) props.onCancel();
  };
  const commentNow = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await props.onCommentNow(...args());
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
          <button type="button" aria-pressed={!suggesting} onClick={() => setSuggesting(false)}>
            Comment
          </button>
          <button
            type="button"
            aria-pressed={suggesting}
            aria-disabled={!canSuggest}
            title={canSuggest ? undefined : signedIn ? "The source lines aren't loaded" : "Sign in to suggest a change"}
            onClick={() => canSuggest && setSuggesting(true)}
          >
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
          {suggesting && (
            <>
              <p className="rr-composer-note" id={ids.lines}>
                Suggesting a replacement for {wholeLinesLabel(selection)}
              </p>
              <textarea
                id={ids.replacement}
                className="rr-composer-text rr-composer-code"
                autoFocus
                spellCheck={false}
                value={replacement}
                aria-label="Replacement"
                aria-describedby={`${ids.lines} ${ids.hint}`}
                onChange={(e) => setReplacement(e.target.value)}
              />
              <ChangeDiff
                label="Preview of the change"
                original={lines(original ?? "")}
                proposed={lines(replacement)}
              />
              {unchanged && <p className="rr-composer-note">Edit the replacement to suggest a change.</p>}
            </>
          )}
          {preview ? (
            <div className="rr-composer-preview">
              {blank ? <p className="rr-composer-note">Nothing to preview.</p> : <Markdown source={text} />}
            </div>
          ) : (
            <>
              <label className="rr-sr-only" htmlFor={ids.text}>
                {suggesting ? "Comment (optional)" : "Comment"}
              </label>
              <textarea
                id={ids.text}
                className="rr-composer-text"
                autoFocus={!suggesting}
                value={text}
                placeholder={suggesting ? "Why this change? (optional, Markdown)" : "Leave a comment (Markdown)"}
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
          <RepresentationHint
            representation={suggesting ? { reason: suggestionReason(representation) } : representation}
            id={ids.hint}
          />
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

const lines = (text: string) => (text === "" ? [] : text.split("\n"));

/** "line 24" or "lines 22–24": the whole lines a suggestion replaces. */
function wholeLinesLabel(selection: SourceSelection) {
  const { startLine, endLine } = selectedLines(selection);
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
}
