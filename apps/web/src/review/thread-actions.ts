// SPDX-License-Identifier: AGPL-3.0-only
// Replying to and resolving threads. Native review threads use GitHub's review reply API and
// GraphQL resolution; application threads (`app:<root comment id>`) are PR conversation comments
// whose annotation names the thread (`threadId`) and the comment answered (`replyTo`).
import { composeCommentBody, type RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import type { NativeThread } from "@rendered-review/review-domain";
import { useMutation } from "@tanstack/react-query";
import { commentMutation, replyMutation, resolveMutation } from "../github/mutations";
import type { PrIdentity } from "../github/queries";
import { publishErrorMessage } from "./publish";

export interface ThreadActions {
  signedIn: boolean;
  /** Starts sign-in; without it, signed-out readers get no reply or resolve controls. */
  onSignIn?: () => void;
  /** Rejects with an Error whose message is for the reviewer. */
  reply(thread: NativeThread, text: string): Promise<void>;
  /** Rejects with an Error whose message is for the reviewer. */
  setResolved(thread: NativeThread, resolved: boolean): Promise<void>;
}

export const isAppThread = (thread: NativeThread) => thread.id.startsWith("app:");

type Event = { motivation: "replying" } | { motivation: "resolving"; resolution: "resolved" | "reopened" };

/** Conversation comment body for a reply to, or resolution of, an application thread: same target as its root. */
function appThreadBody(thread: NativeThread, text: string, event: Event): string {
  const root = thread.comments[0]!;
  // Application threads are anchored by their root's validated annotation.
  if (thread.anchor.type !== "annotation")
    throw new Error("This thread's metadata can't be read, so it can't be answered here.");
  const annotation: RenderedReviewAnnotationV1 = {
    version: 1,
    target: thread.anchor.annotation.target,
    ...event,
    ...(event.motivation === "replying" && { replyTo: String(thread.comments.at(-1)!.id) }),
    threadId: String(root.id),
    createdBy: "rendered-review",
  };
  return composeCommentBody({ annotation, comment: text, location: "conversation" });
}

export function useThreadActions(
  id: PrIdentity,
  options: { signedIn: boolean; onSignIn?: () => void; announce: (message: string) => void },
): ThreadActions {
  const comment = useMutation(commentMutation(id));
  const reply = useMutation(replyMutation(id));
  const resolve = useMutation(resolveMutation(id));

  const publish = async (send: () => Promise<unknown>, done: string) => {
    try {
      await send();
    } catch (error) {
      throw new Error(publishErrorMessage(error as Error), { cause: error });
    }
    options.announce(done);
  };
  const conversation = (body: string) => comment.mutateAsync({ representation: "conversation", body });

  return {
    signedIn: options.signedIn,
    onSignIn: options.onSignIn,
    reply: (thread, text) =>
      publish(
        () =>
          isAppThread(thread)
            ? conversation(appThreadBody(thread, text, { motivation: "replying" }))
            : reply.mutateAsync({ inReplyTo: thread.comments[0]!.id, body: text }),
        "Reply posted",
      ),
    setResolved: (thread, resolved) =>
      publish(
        () => {
          if (!isAppThread(thread)) return resolve.mutateAsync({ threadNodeId: thread.id, resolved });
          const word = resolved ? "Resolved" : "Reopened";
          const text = `${word} [this thread](${thread.comments[0]!.htmlUrl}).`;
          return conversation(
            appThreadBody(thread, text, { motivation: "resolving", resolution: resolved ? "resolved" : "reopened" }),
          );
        },
        resolved ? "Thread resolved" : "Thread reopened",
      ),
  };
}
