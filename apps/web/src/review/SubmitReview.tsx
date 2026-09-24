// SPDX-License-Identifier: AGPL-3.0-only
// The submit-review dialog: summary, verdict, and the drafts grouped by where GitHub will store
// them. Stale drafts need explicit confirmation; drafts that fail to publish are kept.
import { useEffect, useId, useRef, useState } from "react";
import { linesLabel } from "../document/SelectionPopover";
import { commentIntent } from "./compose";
import type { Draft } from "./drafts";
import { type DraftOutcome, type Publisher, PUBLISHING_UNAVAILABLE, type Verdict } from "./publish";
import { Badge } from "./ThreadCard";

const GROUPS = [
  { kind: "review-line", title: "Native review comments", note: "Posted together as one review, on their diff lines." },
  { kind: "review-file", title: "File comments", note: "Posted on their files; GitHub has no line for them." },
  {
    kind: "conversation",
    title: "PR conversation comments",
    note: "Posted to the PR conversation, with quote and permalink.",
  },
] as const;

const VERDICTS: [Verdict, string][] = [
  ["COMMENT", "Comment"],
  ["APPROVE", "Approve"],
  ["REQUEST_CHANGES", "Request changes"],
];

export interface SubmitReviewProps {
  drafts: Draft[];
  /** The PR's current head; drafts written against another are stale. */
  headOid: string;
  /** Absent until publishing exists: submitting is disabled with a note. */
  publisher?: Publisher;
  /** Drafts that were published and should be removed. */
  onPublished: (ids: string[]) => void;
  onClose: () => void;
}

export function SubmitReview({ drafts, headOid, publisher, onPublished, onClose }: SubmitReviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = { title: useId(), summary: useId(), unavailable: useId() };
  const [summary, setSummary] = useState("");
  const [verdict, setVerdict] = useState<Verdict>("COMMENT");
  const [staleConfirmed, setStaleConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ published: number; failed: { draft?: Draft; message: string }[] }>();

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const stale = drafts.filter((d) => d.headOid !== headOid);
  const empty = verdict === "COMMENT" && !summary.trim() && drafts.length === 0;
  const blocked = !publisher || busy || empty || (stale.length > 0 && !staleConfirmed);

  async function submit() {
    if (!publisher) return;
    setBusy(true);
    setReport(undefined);
    try {
      const intents = drafts.map((d) => ({ id: d.id, ...commentIntent(d, headOid) }));
      const outcomes: DraftOutcome[] = await publisher.submitReview(intents, summary.trim(), verdict);
      const published = outcomes.filter((o) => o.ok).map((o) => o.draftId);
      const failed = outcomes.flatMap((o) =>
        o.ok ? [] : [{ draft: drafts.find((d) => d.id === o.draftId), message: o.message }],
      );
      if (published.length) onPublished(published);
      if (failed.length) setReport({ published: published.length, failed });
      else dialog.current?.close();
    } catch (error) {
      setReport({ published: 0, failed: [{ message: (error as Error).message }] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="rr-dialog rr-review-dialog" aria-labelledby={ids.title} onClose={onClose}>
      <div className="rr-dialog-head">
        <h2 id={ids.title}>Submit review</h2>
        <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
      </div>
      <div className="rr-dialog-body">
        <label className="rr-field-label" htmlFor={ids.summary}>
          Summary (optional)
        </label>
        <textarea
          id={ids.summary}
          className="rr-composer-text"
          value={summary}
          placeholder="Overall feedback, posted as the review body"
          onChange={(e) => setSummary(e.target.value)}
        />
        <fieldset className="rr-verdict">
          <legend className="rr-field-label">Verdict</legend>
          {VERDICTS.map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="rr-verdict"
                value={value}
                checked={verdict === value}
                onChange={() => setVerdict(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {drafts.length === 0 ? (
          <p className="rr-composer-note">No drafts yet. Add comments to the review from the document.</p>
        ) : (
          GROUPS.map((g) => {
            const items = drafts.filter((d) => d.representation.kind === g.kind);
            return (
              items.length > 0 && (
                <fieldset key={g.kind} className="rr-draft-group">
                  <legend className="rr-field-label">
                    {g.title} <span className="rr-count">{items.length}</span>
                  </legend>
                  <p className="rr-composer-note">{g.note}</p>
                  <ul>
                    {items.map((d) => (
                      <li key={d.id}>
                        <span className="rr-draft-loc">
                          <code>{d.path}</code> · {linesLabel(d.selection)}
                        </span>
                        {d.headOid !== headOid && (
                          <Badge tone="mod" icon="warn">
                            Stale
                          </Badge>
                        )}
                        <span className="rr-draft-excerpt">{d.comment}</span>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )
            );
          })
        )}

        {stale.length > 0 && (
          <div className="rr-stale-warning">
            <p>
              {stale.length === 1 ? "1 draft was" : `${stale.length} drafts were`} written against an older version of
              the pull request. The text they quote may have moved or changed.
            </p>
            <label>
              <input type="checkbox" checked={staleConfirmed} onChange={(e) => setStaleConfirmed(e.target.checked)} />
              Publish stale drafts anyway
            </label>
          </div>
        )}

        {report && (
          <div className="rr-composer-error" role="alert">
            <p>
              {report.published} published. {report.failed.length} not published:
            </p>
            <ul>
              {report.failed.map((f, i) => (
                <li key={f.draft?.id ?? i}>
                  {f.draft && (
                    <>
                      <code>{f.draft.path}</code> · {linesLabel(f.draft.selection)}:{" "}
                    </>
                  )}
                  {f.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="rr-dialog-foot">
        {!publisher && (
          <p className="rr-composer-note" id={ids.unavailable}>
            {PUBLISHING_UNAVAILABLE}
          </p>
        )}
        <span className="rr-spacer" />
        <button
          type="button"
          className="rr-btn rr-btn-primary"
          disabled={blocked}
          aria-describedby={publisher ? undefined : ids.unavailable}
          onClick={() => void submit()}
        >
          Submit review
        </button>
      </div>
    </dialog>
  );
}
