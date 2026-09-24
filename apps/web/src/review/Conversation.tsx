// SPDX-License-Identifier: AGPL-3.0-only
// PR-level content that has no place in a document: conversation comments and review summaries.
import type { Review } from "@rendered-review/github-integration";
import type { ConversationEntry, InferredLocation, RepositoryRef } from "@rendered-review/review-domain";
import { Markdown } from "./Markdown";
import { blobUrl } from "./model";
import { Badge, CommentHead, type ReviewIconName } from "./ThreadCard";

const lines = (l: InferredLocation) =>
  l.startLine === l.endLine ? `L${l.startLine}` : `L${l.startLine}–L${l.endLine}`;

/** Ordinary PR conversation comments. Permalinked ranges are labelled as inferred, never as anchors. */
export function ConversationPanel({
  entries,
  repository,
}: {
  entries: ConversationEntry[];
  repository: RepositoryRef;
}) {
  return (
    <section className="rr-panel" aria-labelledby="rr-conversation-title">
      <h2 id="rr-conversation-title" className="rr-panel-title">
        Conversation <span className="rr-count">{entries.length}</span>
      </h2>
      {!entries.length && <p className="rr-rail-empty">No conversation comments.</p>}
      {entries.map(({ comment, inferred }) => (
        <article key={comment.id} className="rr-thread" aria-label={`Comment by ${comment.author?.login ?? "ghost"}`}>
          <div className="rr-c">
            <CommentHead author={comment.author} createdAt={comment.createdAt} updatedAt={comment.updatedAt} />
            {inferred.map((l) => (
              <p key={`${l.sha}:${l.path}:${l.startLine}-${l.endLine}`} className="rr-inferred">
                <Badge tone="neutral">Inferred location</Badge>
                <a href={blobUrl(repository, l.sha, l.path, l)} target="_blank" rel="noreferrer">
                  {l.path} · {lines(l)} @ <code>{l.sha.slice(0, 7)}</code>
                </a>
              </p>
            ))}
            <Markdown source={comment.body} />
          </div>
          <div className="rr-t-foot">
            <span className="rr-t-loc">PR conversation comment</span>
            <span className="rr-spacer" />
            <a className="rr-btn rr-btn-sm rr-btn-ghost" href={comment.htmlUrl} target="_blank" rel="noreferrer">
              View on GitHub
            </a>
          </div>
        </article>
      ))}
    </section>
  );
}

const REVIEW_STATE: Record<
  Review["state"],
  { label: string; icon: ReviewIconName; tone: "added" | "del" | "neutral" }
> = {
  APPROVED: { label: "Approved", icon: "check", tone: "added" },
  CHANGES_REQUESTED: { label: "Changes requested", icon: "change", tone: "del" },
  COMMENTED: { label: "Commented", icon: "comment", tone: "neutral" },
  DISMISSED: { label: "Dismissed", icon: "dismiss", tone: "neutral" },
  PENDING: { label: "Pending", icon: "dot", tone: "neutral" },
};

/** Submitted review bodies with their verdict. */
export function ReviewSummaries({ reviews }: { reviews: Review[] }) {
  return (
    <section className="rr-panel" aria-labelledby="rr-reviews-title">
      <h2 id="rr-reviews-title" className="rr-panel-title">
        Reviews <span className="rr-count">{reviews.length}</span>
      </h2>
      {!reviews.length && <p className="rr-rail-empty">No review summaries.</p>}
      {reviews.map((r) => {
        const state = REVIEW_STATE[r.state];
        const at = r.submittedAt ?? "";
        return (
          <article key={r.id} className="rr-thread" aria-label={`${state.label} by ${r.author?.login ?? "ghost"}`}>
            <div className="rr-c">
              <CommentHead author={r.author} createdAt={at} updatedAt={at}>
                <Badge tone={state.tone} icon={state.icon}>
                  {state.label}
                </Badge>
              </CommentHead>
              <Markdown source={r.body} />
            </div>
            <div className="rr-t-foot">
              <span className="rr-t-loc">Review summary</span>
              <span className="rr-spacer" />
              <a className="rr-btn rr-btn-sm rr-btn-ghost" href={r.htmlUrl} target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            </div>
          </article>
        );
      })}
    </section>
  );
}
