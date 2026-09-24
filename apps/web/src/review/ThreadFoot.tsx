// SPDX-License-Identifier: AGPL-3.0-only
// A thread card's footer: location and links (children), Reply / Resolve / Reopen, and the inline
// reply box.
import type { NativeThread } from "@rendered-review/review-domain";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { RepresentationHint } from "./Composer";
import { Markdown } from "./Markdown";
import { isAppThread, type ThreadActions } from "./thread-actions";

const NATIVE_HINT = {
  kind: "conversation",
  reason: "Will post as review thread reply · GitHub shows it in this thread",
} as const;
const APP_HINT = {
  kind: "conversation",
  reason: "Will post as PR conversation comment · its metadata links it to this thread",
} as const;

export interface ThreadFootProps {
  thread: NativeThread;
  actions?: ThreadActions;
  /** Who and where, for control labels: "thread by alice, GitHub line comment · L3". */
  context: string;
  /** Set while a resolve or reopen is in flight, so the card can take focus when it collapses or expands. */
  resolving: RefObject<boolean>;
  children: ReactNode;
}

export function ThreadFoot({ thread, actions, context, resolving, children }: ThreadFootProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [resolveFailure, setResolveFailure] = useState<string>();
  // Synchronous guards: a second click or shortcut can arrive before the disabled state renders.
  const inFlight = useRef({ reply: false, resolve: false });
  const replyButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const ids = { text: useId(), unknown: useId() };

  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    replyButton.current?.focus();
  }, [open]);

  const close = () => {
    returnFocus.current = true;
    setOpen(false);
    setText("");
    setPreview(false);
    setFailure(undefined);
  };
  const cancel = () => (!text.trim() || confirm("Discard this reply?")) && close();
  const send = async () => {
    if (!actions || !text.trim() || inFlight.current.reply) return;
    inFlight.current.reply = true;
    setSending(true);
    setFailure(undefined);
    try {
      await actions.reply(thread, text);
      close();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      inFlight.current.reply = false;
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Handled here: the slide-over rail would close on it too.
      event.stopPropagation();
      cancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  const resolved = thread.resolution === "resolved";
  const known = thread.resolution !== "unknown";
  const toggleResolved = async () => {
    if (!actions || !known || inFlight.current.resolve) return;
    inFlight.current.resolve = true;
    resolving.current = true;
    setBusy(true);
    setResolveFailure(undefined);
    try {
      await actions.setResolved(thread, !resolved);
    } catch (e) {
      resolving.current = false;
      setResolveFailure((e as Error).message);
    } finally {
      inFlight.current.resolve = false;
      setBusy(false);
    }
  };

  const controls = !actions
    ? null
    : !actions.signedIn
      ? actions.onSignIn && (
          <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={actions.onSignIn}>
            Sign in to reply
          </button>
        )
      : !open && (
          <>
            <button
              ref={replyButton}
              type="button"
              className="rr-btn rr-btn-sm rr-btn-ghost"
              aria-label={`Reply to ${context}`}
              onClick={() => setOpen(true)}
            >
              Reply
            </button>
            <button
              type="button"
              className="rr-btn rr-btn-sm rr-btn-ghost"
              aria-label={`${resolved ? "Reopen" : "Resolve"} ${context}`}
              aria-disabled={!known || busy || undefined}
              aria-describedby={known ? undefined : ids.unknown}
              title={known ? undefined : "GitHub didn't report whether this thread is resolved."}
              onClick={() => void toggleResolved()}
            >
              {resolved ? "Reopen" : "Resolve"}
            </button>
            {!known && (
              <span id={ids.unknown} className="rr-sr-only">
                GitHub didn't report whether this thread is resolved.
              </span>
            )}
          </>
        );

  return (
    <>
      {open && (
        <div className="rr-t-reply" onKeyDown={onKeyDown}>
          {preview ? (
            <div className="rr-composer-preview">
              {text.trim() ? <Markdown source={text} /> : <p className="rr-composer-note">Nothing to preview.</p>}
            </div>
          ) : (
            <>
              <label className="rr-sr-only" htmlFor={ids.text}>
                Reply to {context.split(", ")[0]}
              </label>
              <textarea
                id={ids.text}
                className="rr-composer-text"
                autoFocus
                value={text}
                placeholder="Reply (Markdown)"
                aria-keyshortcuts="Control+Enter Meta+Enter"
                onChange={(e) => setText(e.target.value)}
              />
            </>
          )}
          {failure && (
            <p className="rr-composer-error" role="alert">
              {failure}
            </p>
          )}
          <RepresentationHint representation={isAppThread(thread) ? APP_HINT : NATIVE_HINT} />
          <div className="rr-composer-actions">
            <button
              type="button"
              className="rr-btn rr-btn-sm rr-btn-primary"
              disabled={!text.trim() || sending}
              onClick={() => void send()}
            >
              Reply
            </button>
            <button
              type="button"
              className="rr-btn rr-btn-sm rr-btn-ghost"
              aria-pressed={preview}
              onClick={() => setPreview(!preview)}
            >
              Preview
            </button>
            <span className="rr-spacer" />
            <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="rr-t-foot">
        {children}
        {controls}
      </div>
      {resolveFailure && (
        <p className="rr-composer-error rr-t-error" role="alert">
          {resolveFailure}
        </p>
      )}
    </>
  );
}
