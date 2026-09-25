// SPDX-License-Identifier: AGPL-3.0-only
// The publishing seam between the composer / review dialog and GitHub. Components take a
// `Publisher`; the page gets one from `useGitHubPublisher`, which goes through the app's write
// boundary (`github/mutations.ts`).
import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { type CommentInput, commentMutation, PublishError, reviewMutation } from "../github/mutations";
import type { PrIdentity } from "../github/queries";

/** One comment to publish, against the head it was checked against. */
export type CommentIntent = CommentInput & { expectedHeadOid: string };

export type Verdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/**
 * Outcome for one draft of a submitted review; failed drafts are kept for another try.
 * `retryAs`: GitHub refused the diff location, a file comment should work. `cause`: the refusal.
 */
export type DraftOutcome = { draftId: string } & (
  { ok: true } | { ok: false; message: string; retryAs?: "review-file"; cause?: unknown }
);

export interface Publisher {
  /** Publishes one comment now. Rejects with a `PublishError` (or another `Error`). */
  publishComment(intent: CommentIntent): Promise<void>;
  /** Submits drafts and an optional summary as one review. Resolves with one outcome per draft, even on partial failure. */
  submitReview(intents: (CommentIntent & { id: string })[], summary: string, verdict: Verdict): Promise<DraftOutcome[]>;
}

/** What to tell the reviewer about a refused publish. */
export function publishErrorMessage(error: { code?: string; message: string; resetAt?: string }): string {
  switch (error.code) {
    case "stale-head":
      return "The pull request has new commits since this page loaded. Your text is kept; reload to comment on the latest version.";
    case "needs-public-authorization":
      return "GitHub needs your permission to comment on public repositories. Opening GitHub to ask…";
    case "comment-changed":
      return "The comment changed on GitHub since this page loaded, so it was left as it is. Reload to see the latest version.";
    case "private-repo-unsupported":
      return "Commenting on private repositories isn't supported yet.";
    case "reauth":
    case "unauthenticated":
      return "Your GitHub sign-in has expired. Sign in again, then retry.";
    case "rate-limited":
      return `GitHub's rate limit was reached. Try again${error.resetAt ? ` after ${new Date(error.resetAt).toLocaleTimeString()}` : " later"}.`;
    default:
      return error.message;
  }
}

/** Publishes through the app's write boundary for the PR `id`. */
export function useGitHubPublisher(id: PrIdentity): Publisher {
  const comment = useMutation(commentMutation(id));
  const review = useMutation(reviewMutation(id));
  // A submission that failed in transit is sent again under the same id, so it is published once.
  const lastSubmission = useRef<{ key: string; id: string }>(undefined);
  return {
    publishComment: async (intent) => {
      await comment.mutateAsync(intent);
    },
    submitReview: async (intents, summary, verdict) => {
      const input = { event: verdict, ...(summary && { body: summary }), drafts: intents };
      const key = JSON.stringify(input);
      if (lastSubmission.current?.key !== key) lastSubmission.current = { key, id: crypto.randomUUID() };
      try {
        const result = await review.mutateAsync({ submissionId: lastSubmission.current.id, ...input });
        lastSubmission.current = undefined;
        // The review itself (summary or verdict only) can fail with no draft to report it on.
        if (result.review && !result.review.ok && !intents.some((i) => i.representation === "review-line"))
          throw new PublishError(422, result.review.error);
        return result.results.map((r) =>
          r.ok
            ? { draftId: r.draftId, ok: true }
            : {
                draftId: r.draftId,
                ok: false,
                message: publishErrorMessage(r.error),
                retryAs: r.error.retryAs,
                cause: r.error,
              },
        );
      } catch (error) {
        // Refused before publishing anything: a changed submission gets a new id anyway.
        if (error instanceof PublishError) lastSubmission.current = undefined;
        throw error;
      }
    },
  };
}
