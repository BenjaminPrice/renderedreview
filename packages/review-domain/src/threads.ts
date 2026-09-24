// SPDX-License-Identifier: AGPL-3.0-only
// Rebuilds application threads from PR conversation comments (design §3): replies name their
// thread root (`threadId`) and/or the comment they answer (`replyTo`) by GitHub comment id, as a
// decimal string; resolve/reopen are `resolving` comments naming the thread. Pure, no I/O.
import type { IssueComment } from "@rendered-review/github-integration";
import { type Classification, classifyComment, type CommentContext } from "./classify.js";
import type { NativeThread, ResolutionEvent } from "./projection.js";

export interface ClassifiedComment {
  comment: IssueComment;
  classification: Classification;
}

export interface ReconstructedThreads {
  threads: NativeThread[];
  /** Everything that is not part of an application thread, in input order. */
  rest: ClassifiedComment[];
}

const byTime = (a: IssueComment, b: IssueComment) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id;

/**
 * Group a pull request's conversation comments into application threads. Only comments whose
 * metadata validated against `context` take part, and a reference only counts when it names an
 * older such comment loaded with the same pull request (GitHub assigns ids in creation order, so
 * references can never form a cycle). A reply whose parent is missing starts its own thread; a
 * resolution event with no thread stays in the conversation. Nothing is dropped.
 */
export function reconstructThreads(comments: IssueComment[], context: CommentContext): ReconstructedThreads {
  const classified = comments.map((comment) => ({ comment, classification: classifyComment(comment, context) }));
  const app = new Map(classified.filter((c) => c.classification.annotation).map((c) => [c.comment.id, c]));
  const isEvent = (c: ClassifiedComment) => c.classification.annotation!.motivation === "resolving";

  const parent = (c: ClassifiedComment) => {
    const { threadId, replyTo } = c.classification.annotation!;
    for (const ref of [threadId, replyTo]) {
      const p = ref !== undefined && /^\d+$/.test(ref) ? app.get(Number(ref)) : undefined;
      if (p && p.comment.id < c.comment.id && !isEvent(p)) return p;
    }
  };
  const rootOf = (c: ClassifiedComment): ClassifiedComment => {
    const p = parent(c);
    return p ? rootOf(p) : c;
  };

  const members = new Map<ClassifiedComment, ClassifiedComment[]>();
  const rest: ClassifiedComment[] = [];
  for (const c of classified) {
    if (!app.has(c.comment.id)) {
      rest.push(c);
      continue;
    }
    const root = rootOf(c);
    if (root === c && isEvent(c)) rest.push(c);
    else members.set(root, [...(members.get(root) ?? []), c]);
  }

  const threads = [...members].map(([root, all]): NativeThread => {
    const annotation = root.classification.annotation!;
    const events: ResolutionEvent[] = all
      .filter(isEvent)
      .map((e) => e.comment)
      .sort(byTime)
      .map((comment) => ({
        resolution: app.get(comment.id)!.classification.annotation!.resolution ?? "resolved",
        at: comment.createdAt,
        comment,
      }));
    const replies = all.filter((c) => c !== root && !isEvent(c)).map((c) => c.comment);
    const thread: NativeThread = {
      id: `app:${root.comment.id}`,
      path: annotation.target.path,
      comments: [root.comment, ...replies.sort(byTime)],
      resolution: events.at(-1)?.resolution === "resolved" ? "resolved" : "unresolved",
      anchor: { type: "annotation", annotation },
      metadata: Object.fromEntries(all.map((c) => [c.comment.id, c.classification])),
    };
    if (events.length) thread.events = events;
    return thread;
  });
  return { threads: threads.sort((a, b) => byTime(a.comments[0]!, b.comments[0]!)), rest };
}
