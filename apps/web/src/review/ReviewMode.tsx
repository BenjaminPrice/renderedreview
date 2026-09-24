// SPDX-License-Identifier: AGPL-3.0-only
// Commenting on a PR page: the composer for a new selection, drafts in the rail, the top-bar
// Review button and its submit dialog. The page places what `useReviewMode` returns.
import type { ChangedFile, PullRequest } from "@rendered-review/github-integration";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import type { Representation } from "@rendered-review/review-domain";
import { type ReactNode, useState } from "react";
import type { DocEntry } from "../document/docs";
import type { LoadedDocument } from "../document/document";
import { PublishError } from "../github/mutations";
import type { PrIdentity } from "../github/queries";
import { linesLabel } from "../document/SelectionPopover";
import { signIn } from "../ui/Viewer";
import { commentIntent, composeDraftBody, prepareAnnotation, representationFor } from "./compose";
import { Composer } from "./Composer";
import { DraftCard } from "./DraftCard";
import { type Draft, useDrafts } from "./drafts";
import { type Publisher, publishErrorMessage, useGitHubPublisher } from "./publish";
import { SubmitReview } from "./SubmitReview";
import { useThreadActions } from "./thread-actions";
import { threadDomId } from "./ThreadCard";

const AS_FILE: Representation = {
  kind: "review-file",
  reason: "Will post as file comment · GitHub refused its diff lines",
};

export interface ReviewModeInput {
  pr: PullRequest;
  id: PrIdentity;
  files: ChangedFile[];
  /** The open document, if any. */
  entry: DocEntry | undefined;
  doc: LoadedDocument;
  viewer: { signedIn: boolean; signInEnabled: boolean } | undefined;
}

export function useReviewMode({ pr, id, files, entry, doc, viewer }: ReviewModeInput) {
  const { drafts, save, remove } = useDrafts({
    host: id.host,
    repositoryId: id.repositoryId,
    number: id.number,
    private: pr.base.repository?.private !== false,
  });
  const github = useGitHubPublisher(id);
  const [pending, setPending] = useState<{ path: string; selection: SourceSelection } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Outcome worth telling after the composer closes; kept until dismissed or the next comment.
  const [notice, setNotice] = useState<string | null>(null);
  const signedIn = !!viewer?.signedIn;
  // Screen-reader announcement of a thread reply or resolution; the card itself shows failures.
  // Keyed by count, so the same message twice is announced twice.
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const threadActions = useThreadActions(id, {
    signedIn,
    onSignIn: viewer?.signInEnabled ? () => void signIn() : undefined,
    announce: (text) => setAnnouncement((a) => ({ text, n: a.n + 1 })),
  });

  /** Publishes `comment` on `annotation`, as a file comment if GitHub refuses the diff lines. */
  async function publishNow(
    path: string,
    representation: Representation,
    annotation: Draft["annotation"],
    comment: string,
    selection: SourceSelection,
  ) {
    const send = (r: Representation) =>
      github.publishComment(
        commentIntent({ path, representation: r, body: composeDraftBody(annotation, comment, r) }, id.headSha),
      );
    try {
      await send(representation).catch((error: unknown) => {
        if (!(error instanceof PublishError && error.retryAs === "review-file")) throw error;
        return send(AS_FILE).then(() =>
          setNotice(
            `Posted as a file comment · GitHub refused ${linesLabel(selection)} as a diff location, so it is on the file instead.`,
          ),
        );
      });
    } catch (error) {
      throw new Error(publishErrorMessage(error as Error), { cause: error });
    }
  }

  // Drafts GitHub refused on their diff lines become file comments, for the next submission.
  const publisher: Publisher = {
    publishComment: github.publishComment,
    submitReview: async (...args) => {
      const outcomes = await github.submitReview(...args);
      return outcomes.map((o) => {
        const d = !o.ok && o.retryAs && drafts.find((x) => x.id === o.draftId);
        if (!d || o.ok) return o;
        save({ ...d, representation: AS_FILE, body: composeDraftBody(d.annotation, d.comment, AS_FILE) });
        return { ...o, message: `${o.message}. It is now a file comment; submit again to post it.` };
      });
    },
  };

  const here = (d: Draft) => d.path === entry?.path;
  const stale = (d: Draft) => d.headOid !== id.headSha;
  const target = entry && {
    host: id.host,
    repositoryId: id.repositoryId,
    repository: `${id.owner}/${id.repo}`,
    pullRequest: id.number,
    path: entry.path,
    commitOid: doc.sha,
    blobOid: entry.oid,
  };

  const extras: { id: string; blockId: number; element: ReactNode }[] = [];
  const unplaced: ReactNode[] = [];

  const composing = pending && target && pending.path === target.path ? pending.selection : undefined;
  if (composing && target) {
    const prepared = prepareAnnotation(target, composing);
    const representation = representationFor(files, target.path, composing);
    extras.push({
      id: "composer",
      blockId: composing.blockIds[0] ?? 0,
      element: (
        <Composer
          key={`${composing.textPosition.start}-${composing.textPosition.end}`}
          id={threadDomId("composer")}
          selection={composing}
          representation={representation}
          error={prepared.ok ? undefined : prepared.message}
          signedIn={signedIn}
          onSignIn={viewer?.signInEnabled ? () => void signIn() : undefined}
          onCancel={() => setPending(null)}
          onAddToReview={(comment) => {
            if (!prepared.ok) return;
            save({
              id: crypto.randomUUID(),
              headOid: id.headSha,
              path: target.path,
              selection: composing,
              representation,
              comment,
              body: composeDraftBody(prepared.annotation, comment, representation),
              annotation: prepared.annotation,
              createdAt: new Date().toISOString(),
            });
            setPending(null);
          }}
          onCommentNow={async (comment) => {
            if (!prepared.ok) return;
            await publishNow(target.path, representation, prepared.annotation, comment, composing);
            setPending(null);
          }}
        />
      ),
    });
  }

  for (const d of drafts.filter(here)) {
    const domId = threadDomId(`draft-${d.id}`);
    const element =
      editing === d.id ? (
        <Composer
          key={d.id}
          id={domId}
          editing
          initial={d.comment}
          selection={d.selection}
          representation={d.representation}
          signedIn
          onCancel={() => setEditing(null)}
          onAddToReview={(comment) => {
            save({ ...d, comment, body: composeDraftBody(d.annotation, comment, d.representation) });
            setEditing(null);
          }}
          onCommentNow={async () => {}}
        />
      ) : (
        <DraftCard
          key={d.id}
          id={domId}
          draft={d}
          stale={stale(d)}
          onEdit={() => setEditing(d.id)}
          onDelete={() => remove([d.id])}
        />
      );
    const blockId = d.selection.blockIds[0];
    // Stale drafts' blocks belong to another revision; they wait for re-anchoring.
    if (blockId === undefined || stale(d)) unplaced.push(element);
    else extras.push({ id: `draft-${d.id}`, blockId, element });
  }

  const editedDraft = drafts.find((d) => d.id === editing && here(d) && !stale(d));
  return {
    compose: (path: string, selection: SourceSelection) => {
      setEditing(null);
      setNotice(null);
      setPending({ path, selection });
    },
    /** The selection to highlight in the document: the one being commented on or edited. */
    highlighted: composing ?? editedDraft?.selection,
    extras,
    threadActions,
    /** Always rendered, so screen readers announce what appears in it. */
    status: (
      <div className="rr-rail-status" role="status" aria-label="Publishing status">
        <span key={announcement.n} className="rr-sr-only">
          {announcement.text}
        </span>
        {notice && (
          <p className="rr-composer-note">
            {notice}{" "}
            <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </p>
        )}
      </div>
    ),
    unplacedDrafts: unplaced.length > 0 && (
      <section className="rr-rail-group" aria-labelledby="rr-rail-unplaced-drafts">
        <h3 id="rr-rail-unplaced-drafts" className="rr-rail-group-title">
          Drafts not placed in document
        </h3>
        {unplaced}
      </section>
    ),
    reviewButton: signedIn && (
      <>
        <button type="button" className="rr-btn rr-btn-primary" onClick={() => setSubmitting(true)}>
          Review <span className="rr-count">{drafts.length}</span>
          <span className="rr-sr-only"> draft{drafts.length === 1 ? "" : "s"}</span>
        </button>
        {submitting && (
          <SubmitReview
            drafts={drafts}
            headOid={id.headSha}
            publisher={publisher}
            onPublished={remove}
            onClose={() => setSubmitting(false)}
          />
        )}
      </>
    ),
  };
}
