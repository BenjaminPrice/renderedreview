// SPDX-License-Identifier: AGPL-3.0-only
// A comment added to the review but not published yet, shown in the rail at its anchor.
import { linesLabel } from "../document/SelectionPopover";
import { Quote, RepresentationHint } from "./Composer";
import type { Draft } from "./drafts";
import { Markdown } from "./Markdown";
import { Badge } from "./ThreadCard";

export function DraftCard({
  draft,
  stale,
  onEdit,
  onDelete,
  id,
}: {
  draft: Draft;
  /** Written against another head than the PR's current one. */
  stale: boolean;
  onEdit: () => void;
  onDelete: () => void;
  id?: string;
}) {
  return (
    <section id={id} className="rr-thread rr-draft" aria-label={`Draft comment on ${linesLabel(draft.selection)}`}>
      <div className="rr-composer-top">
        <Badge tone="neutral">Draft</Badge>
        {stale && (
          <Badge tone="mod" icon="warn">
            Stale
          </Badge>
        )}
      </div>
      <Quote selection={draft.selection} />
      <div className="rr-draft-body">
        <Markdown source={draft.comment} />
      </div>
      {stale && (
        <p className="rr-composer-note">
          Written against <code>{draft.headOid.slice(0, 7)}</code>; the pull request has changed since.
        </p>
      )}
      <RepresentationHint representation={draft.representation} />
      <div className="rr-composer-actions">
        <button type="button" className="rr-btn rr-btn-sm" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="rr-btn rr-btn-sm rr-btn-ghost"
          title="Copy the comment as it would be posted to GitHub"
          onClick={() => void navigator.clipboard?.writeText(draft.body)}
        >
          Copy
        </button>
        <span className="rr-spacer" />
        <button
          type="button"
          className="rr-btn rr-btn-sm rr-btn-ghost"
          onClick={() => confirm("Delete this draft?") && onDelete()}
        >
          Delete
        </button>
      </div>
    </section>
  );
}
