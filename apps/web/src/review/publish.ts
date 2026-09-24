// SPDX-License-Identifier: AGPL-3.0-only
// The publishing seam between the composer / review dialog and GitHub. The page provides a
// `Publisher` through `PublisherContext`; without one, publishing controls stay disabled.
import { createContext } from "react";

type Side = "LEFT" | "RIGHT";

/** One comment to publish, against the head it was checked against. Mirrors the write boundary's comment input. */
export type CommentIntent = { body: string; expectedHeadOid: string } & (
  | { representation: "review-line"; path: string; line: number; side: Side; startLine?: number; startSide?: Side }
  | { representation: "review-file"; path: string }
  | { representation: "conversation" }
);

export type Verdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** Outcome for one draft of a submitted review; failed drafts are kept for another try. */
export type DraftOutcome = { draftId: string } & ({ ok: true } | { ok: false; message: string });

export interface Publisher {
  /** Publishes one comment now. Rejects with an `Error` whose message is shown to the user. */
  publishComment(intent: CommentIntent): Promise<void>;
  /** Submits drafts and an optional summary as one review. Resolves with one outcome per draft, even on partial failure. */
  submitReview(intents: (CommentIntent & { id: string })[], summary: string, verdict: Verdict): Promise<DraftOutcome[]>;
}

export const PublisherContext = createContext<Publisher | undefined>(undefined);

export const PUBLISHING_UNAVAILABLE =
  "Publishing to GitHub is coming soon. Drafts are kept in this browser until then.";
