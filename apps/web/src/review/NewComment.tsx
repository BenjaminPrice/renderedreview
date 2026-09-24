// SPDX-License-Identifier: AGPL-3.0-only
// The Overview's "Add a comment" box below the conversation: a plain PR conversation comment, not
// anchored to any document, so it carries no annotation marker.
import type { BrowserCache } from "@rendered-review/browser-cache";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { commentMutation } from "../github/mutations";
import { type PrIdentity, viewerQuery } from "../github/queries";
import { signIn } from "../ui/Viewer";
import { useUnsentComment } from "./drafts";
import { Markdown } from "./Markdown";
import { publishErrorMessage } from "./publish";
import { initials } from "./ThreadCard";

export function NewConversationComment({
  id,
  isPrivate,
  cache,
}: {
  id: PrIdentity;
  /** Private (or unknown visibility): unsent text stays in this tab's memory only. */
  isPrivate: boolean;
  cache?: BrowserCache;
}) {
  const viewer = useQuery(viewerQuery).data;
  const comment = useMutation(commentMutation(id));
  const [text, setText] = useUnsentComment(
    { host: id.host, repositoryId: id.repositoryId, number: id.number, private: isPrivate },
    cache,
  );
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string>();
  // Keyed by count, so the same message twice is announced twice.
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  // Synchronous guard: a second click or shortcut can arrive before the disabled state renders.
  const inFlight = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const ids = { heading: useId(), text: useId() };
  // Posted: back in the box (the preview, if shown, has turned back into it) for the next comment.
  useEffect(() => {
    if (announcement.n) box.current?.focus();
  }, [announcement.n]);

  if (!viewer?.signInEnabled) return null;

  const send = async () => {
    if (!text.trim() || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setFailure(undefined);
    try {
      await comment.mutateAsync({ representation: "conversation", body: text });
      setText("");
      setPreview(false);
      setAnnouncement((a) => ({ text: "Comment posted", n: a.n + 1 }));
    } catch (e) {
      setFailure(publishErrorMessage(e as Error));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <section className="rr-tl-item rr-tl-new" aria-labelledby={ids.heading} onKeyDown={onKeyDown}>
      <span className="rr-avatar rr-tl-av" aria-hidden="true">
        {viewer.login ? initials(viewer.login) : "?"}
      </span>
      <div className="rr-tl-card">
        <div className="rr-desc-head">
          <h3 id={ids.heading}>Add a comment</h3>
          <span className="rr-spacer" />
          {viewer.signedIn && (
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
        {!viewer.signedIn ? (
          <div className="rr-composer-actions">
            <button type="button" className="rr-btn rr-btn-sm rr-btn-primary" onClick={() => void signIn()}>
              Sign in to comment
            </button>
          </div>
        ) : (
          <>
            {preview ? (
              <div className="rr-composer-preview">
                {text.trim() ? <Markdown source={text} /> : <p className="rr-composer-note">Nothing to preview.</p>}
              </div>
            ) : (
              <>
                <label className="rr-sr-only" htmlFor={ids.text}>
                  Add a comment
                </label>
                <textarea
                  ref={box}
                  id={ids.text}
                  className="rr-composer-text"
                  value={text}
                  placeholder="Leave a comment (Markdown)"
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
            <div className="rr-composer-actions">
              <span className="rr-spacer" />
              <button
                type="button"
                className="rr-btn rr-btn-sm rr-btn-primary"
                disabled={!text.trim() || sending}
                onClick={() => void send()}
              >
                Comment
              </button>
            </div>
          </>
        )}
      </div>
      <div role="status" aria-label="Publishing status">
        <span key={announcement.n} className="rr-sr-only">
          {announcement.text}
        </span>
      </div>
    </section>
  );
}
