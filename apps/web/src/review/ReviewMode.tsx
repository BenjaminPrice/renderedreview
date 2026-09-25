// SPDX-License-Identifier: AGPL-3.0-only
// Commenting on a PR page: the composer for a new selection, drafts in the rail, the top-bar
// Review button and its submit dialog. The page places what `useReviewMode` returns.
import { repairCommentBody } from "@rendered-review/annotation-domain";
import type { ChangedFile, PullRequest } from "@rendered-review/github-integration";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import type { Representation, ThreadPlacement } from "@rendered-review/review-domain";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { DocEntry } from "../document/docs";
import type { LoadedDocument } from "../document/document";
import { editMutation, PublishError } from "../github/mutations";
import type { PrIdentity } from "../github/queries";
import { linesLabel } from "../document/SelectionPopover";
import { signIn } from "../ui/Viewer";
import {
  commentIntent,
  composeDraftBody,
  prepareAnnotation,
  representationFor,
  selectedLines,
  selectedSourceLines,
  type SuggestedChange,
} from "./compose";
import { Composer } from "./Composer";
import { DraftCard } from "./DraftCard";
import { lines, type RepairTarget, repairTarget } from "./model";
import { RepairPreview } from "./RepairPreview";
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
  viewer: { signedIn: boolean; signInEnabled: boolean; githubId?: number } | undefined;
}

export function useReviewMode({ pr, id, files, entry, doc, viewer }: ReviewModeInput) {
  const { drafts, save, remove } = useDrafts({
    host: id.host,
    repositoryId: id.repositoryId,
    number: id.number,
    private: pr.base.repository?.private !== false,
  });
  const github = useGitHubPublisher(id);
  const [pending, setPending] = useState<{ path: string; selection: SourceSelection; suggest?: true } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Repairing the anchor of the viewer's own comment: pick new text in its document, then preview.
  const [repair, setRepair] = useState<{
    threadId: string;
    path: string;
    target: RepairTarget;
    selection?: SourceSelection;
  } | null>(null);
  const edit = useMutation(editMutation(id));
  // Outcome worth telling after the composer closes; kept until dismissed or the next comment.
  const [notice, setNotice] = useState<string | null>(null);
  const signedIn = !!viewer?.signedIn;
  // Screen-reader announcement of a thread reply or resolution; the card itself shows failures.
  // Keyed by count, so the same message twice is announced twice.
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const announce = (text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 }));
  const threadActions = useThreadActions(id, {
    signedIn,
    viewerId: viewer?.githubId,
    authorId: pr.author?.id,
    onSignIn: viewer?.signInEnabled ? () => void signIn() : undefined,
    announce,
  });

  /** Publishes `comment` on `annotation`, as a file comment if GitHub refuses the diff lines. */
  async function publishNow(
    path: string,
    representation: Representation,
    annotation: Draft["annotation"],
    comment: string,
    selection: SourceSelection,
    suggestion: SuggestedChange | undefined,
  ) {
    const send = (r: Representation) =>
      github.publishComment(
        commentIntent(
          { path, representation: r, body: composeDraftBody(annotation, comment, r, suggestion) },
          id.headSha,
        ),
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
        save({
          ...d,
          representation: AS_FILE,
          body: composeDraftBody(d.annotation, d.comment, AS_FILE, d.suggestion),
        });
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
  // The whole source lines a suggestion replaces; none while the source is loading.
  const sourceLines = (selection: SourceSelection) =>
    doc.source === undefined ? undefined : selectedSourceLines(doc.source, selection);
  if (composing && target) {
    const prepared = prepareAnnotation(target, composing);
    const representation = representationFor(files, target.path, composing);
    const original = sourceLines(composing);
    const change = (replacement?: string) =>
      replacement === undefined || original === undefined ? undefined : { original, replacement };
    extras.push({
      id: "composer",
      blockId: composing.blockIds[0] ?? 0,
      element: (
        <Composer
          key={`${composing.textPosition.start}-${composing.textPosition.end}`}
          id={threadDomId("composer")}
          selection={composing}
          representation={representation}
          original={original}
          suggest={pending?.suggest}
          error={prepared.ok ? undefined : prepared.message}
          signedIn={signedIn}
          onSignIn={viewer?.signInEnabled ? () => void signIn() : undefined}
          onCancel={() => setPending(null)}
          onAddToReview={(comment, replacement) => {
            if (!prepared.ok) return;
            const suggestion = change(replacement);
            save({
              id: crypto.randomUUID(),
              headOid: id.headSha,
              path: target.path,
              selection: composing,
              representation,
              comment,
              suggestion,
              body: composeDraftBody(prepared.annotation, comment, representation, suggestion),
              annotation: prepared.annotation,
              createdAt: new Date().toISOString(),
            });
            setPending(null);
          }}
          onCommentNow={async (comment, replacement) => {
            if (!prepared.ok) return;
            await publishNow(target.path, representation, prepared.annotation, comment, composing, change(replacement));
            setPending(null);
          }}
        />
      ),
    });
  }

  const repairing = repair && repair.path === entry?.path ? repair : null;
  if (repairing?.selection && target) {
    const { selection, target: what, threadId } = repairing;
    const prepared = prepareAnnotation(target, selection);
    const picked = selectedLines(selection);
    const on = what.lines;
    const error = !prepared.ok
      ? prepared.message
      : on && (picked.endLine < on.startLine || picked.startLine > on.endLine)
        ? `GitHub keeps this comment on ${lines(on)}: select text there.`
        : undefined;
    // A valid annotation keeps its motivation and thread links; only its target moves.
    const annotation =
      prepared.ok &&
      (what.annotation ? { ...what.annotation, target: prepared.annotation.target } : prepared.annotation);
    const repaired =
      !error && annotation
        ? repairCommentBody({ body: what.comment.body, annotation, location: what.location })
        : undefined;
    extras.push({
      id: "repair",
      blockId: selection.blockIds[0] ?? 0,
      element: (
        <RepairPreview
          key={`${selection.textPosition.start}-${selection.textPosition.end}`}
          id={threadDomId("repair")}
          selection={selection}
          repaired={repaired}
          error={error}
          onCancel={() => setRepair(null)}
          onConfirm={async () => {
            if (!repaired) return;
            try {
              await edit.mutateAsync({
                commentType: what.commentType,
                commentId: what.comment.id,
                previousBody: what.comment.body,
                body: repaired.body,
              });
            } catch (error) {
              throw new Error(publishErrorMessage(error as Error), { cause: error });
            }
            setRepair(null);
            announce("Comment anchor updated");
            // The card has moved to its new place: keyboard focus follows it.
            requestAnimationFrame(() => document.getElementById(threadDomId(threadId))?.focus());
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
          initialReplacement={d.suggestion?.replacement}
          original={d.suggestion?.original ?? (stale(d) ? undefined : sourceLines(d.selection))}
          selection={d.selection}
          representation={d.representation}
          signedIn
          onCancel={() => setEditing(null)}
          onAddToReview={(comment, replacement) => {
            const original = d.suggestion?.original ?? sourceLines(d.selection);
            const suggestion =
              replacement === undefined || original === undefined ? undefined : { original, replacement };
            save({
              ...d,
              comment,
              suggestion,
              body: composeDraftBody(d.annotation, comment, d.representation, suggestion),
            });
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
    compose: (path: string, selection: SourceSelection, suggest?: true) => {
      setEditing(null);
      setNotice(null);
      setRepair(null);
      setPending({ path, selection, suggest });
    },
    /** A repair action for a placed thread's card, when the viewer may repair its anchor. */
    repairFor: (p: ThreadPlacement) => {
      const what = signedIn ? repairTarget(p, viewer?.githubId) : undefined;
      if (!what) return undefined;
      return () => {
        setPending(null);
        setEditing(null);
        setNotice(null);
        setRepair({ threadId: p.thread.id, path: p.thread.path, target: what });
        // Keyboard readers select the new text from the document (Shift+arrows).
        document.querySelector<HTMLElement>('article[aria-label="Rendered document"]')?.focus();
      };
    },
    /** Picking new text for the comment whose anchor is being repaired: the selection toolbar moves it there. */
    repairing: !!repairing,
    chooseRepair: (selection: SourceSelection) => setRepair((r) => r && { ...r, selection }),
    /** The selection to highlight in the document: the one being commented on, edited or repaired onto. */
    highlighted: composing ?? repairing?.selection ?? editedDraft?.selection,
    extras,
    threadActions,
    /** Always rendered, so screen readers announce what appears in it. */
    status: (
      <div className="rr-rail-status" role="status" aria-label="Publishing status">
        <span key={announcement.n} className="rr-sr-only">
          {announcement.text}
        </span>
        {repairing && !repairing.selection && (
          <p className="rr-composer-note">
            Select the text your comment is about, then choose <b>Move comment here</b> (M).{" "}
            <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={() => setRepair(null)}>
              Cancel repair
            </button>
          </p>
        )}
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
