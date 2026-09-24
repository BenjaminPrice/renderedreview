// SPDX-License-Identifier: AGPL-3.0-only
import { composeCommentBody, type RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import type { IssueComment } from "@rendered-review/github-integration";
import { describe, expect, it } from "vitest";
import { annotation, at, context, issueComment, target } from "./fixtures.js";
import { reconstructThreads } from "./threads.js";

const post = (a: RenderedReviewAnnotationV1, second: number, text = "comment") =>
  issueComment(composeCommentBody({ annotation: a, comment: text, location: "conversation" }), {
    createdAt: at(second),
    updatedAt: at(second),
  });
const root = (second = 0) => post(annotation(), second, "root");
const reply = (to: IssueComment | number, second: number, thread?: IssueComment | number) =>
  post(
    annotation({
      motivation: "replying",
      replyTo: String(typeof to === "number" ? to : to.id),
      ...(thread && { threadId: String(typeof thread === "number" ? thread : thread.id) }),
    }),
    second,
    "reply",
  );
const event = (thread: IssueComment | number, second: number, resolution?: "reopened") =>
  post(
    annotation({
      motivation: "resolving",
      threadId: String(typeof thread === "number" ? thread : thread.id),
      ...(resolution && { resolution }),
    }),
    second,
    resolution ?? "resolved",
  );

const ids = (cs: { id: number }[]) => cs.map((c) => c.id);

describe("reconstructThreads", () => {
  it("groups nested replies under their root, oldest first, anchored by the root's annotation", () => {
    const r = root(0);
    const a = reply(r, 10, r);
    const b = reply(a, 20); // reply to a reply, replyTo only
    const { threads, rest } = reconstructThreads([b, r, a], context);
    expect(rest).toEqual([]);
    expect(threads).toHaveLength(1);
    const t = threads[0]!;
    expect(t).toMatchObject({ id: `app:${r.id}`, path: "doc.md", resolution: "unresolved" });
    expect(ids(t.comments)).toEqual([r.id, a.id, b.id]);
    expect(t.anchor).toEqual({ type: "annotation", annotation: annotation() });
    expect(t.metadata?.[a.id]?.state).toBe("valid");
  });

  it("orders by time whatever the input order, keeping the root first", () => {
    const r = root(30);
    const late = reply(r, 50, r);
    const early = reply(r, 5, r); // timestamp before the root's
    const { threads } = reconstructThreads([late, early, r], context);
    expect(ids(threads[0]!.comments)).toEqual([r.id, early.id, late.id]);
  });

  it.each<[string, (r: IssueComment) => IssueComment[], string]>([
    ["resolve", (r) => [event(r, 10)], "resolved"],
    ["resolve then reopen", (r) => [event(r, 10), event(r, 20, "reopened")], "unresolved"],
    ["resolve, reopen, resolve", (r) => [event(r, 10), event(r, 20, "reopened"), event(r, 30)], "resolved"],
    ["events given out of order", (r) => [event(r, 30, "reopened"), event(r, 10)], "unresolved"],
  ])("applies resolution events chronologically: %s", (_name, events, resolution) => {
    const r = root();
    const evs = events(r);
    const { threads, rest } = reconstructThreads([r, ...evs], context);
    expect(threads[0]!.resolution).toBe(resolution);
    // Events are shown as thread events, not as comments or conversation entries.
    expect(ids(threads[0]!.comments)).toEqual([r.id]);
    expect(rest).toEqual([]);
    expect(threads[0]!.events!.map((e) => e.at)).toEqual(evs.map((e) => e.createdAt).sort());
  });

  it("a reply whose parent was deleted becomes its own thread; its replies follow it", () => {
    const deleted = 999_999;
    const first = reply(deleted, 10, deleted);
    const second = post(annotation({ motivation: "replying", threadId: String(deleted) }), 20);
    const answer = reply(first, 30, deleted);
    const { threads, rest } = reconstructThreads([first, second, answer], context);
    expect(rest).toEqual([]);
    expect(threads.map((t) => ids(t.comments))).toEqual([[first.id, answer.id], [second.id]]);
  });

  it("never attaches to a comment of another pull request", () => {
    // Not loaded with this pull request, so the reference cannot be checked: standalone.
    const foreign = reply(123, 10, 123);
    // Names another pull request: damaged, stays in the conversation with its notice.
    const r = root(0);
    const crossPr = post({ ...target({ pullRequest: 8 }), motivation: "replying", replyTo: String(r.id) }, 20);
    const { threads, rest } = reconstructThreads([r, foreign, crossPr], context);
    expect(threads.map((t) => ids(t.comments))).toEqual([[r.id], [foreign.id]]);
    expect(rest.map((e) => [e.comment.id, e.classification.state])).toEqual([[crossPr.id, "damaged"]]);
  });

  it("only attaches to an older comment (ids are assigned in creation order)", () => {
    const r = root(0);
    // Claims to reply to a comment created after it.
    const claim = post(annotation({ motivation: "replying", replyTo: String(r.id + 2) }), 5);
    const later = root(10);
    expect(later.id).toBe(r.id + 2);
    const { threads } = reconstructThreads([r, later, claim], context);
    expect(threads.map((t) => ids(t.comments))).toEqual([[r.id], [claim.id], [later.id]]);
  });

  it("does not attach to plain conversation comments", () => {
    const plain = issueComment("Plain comment", { createdAt: at(0) });
    const r = reply(plain, 10, plain);
    const { threads, rest } = reconstructThreads([plain, r], context);
    expect(threads.map((t) => ids(t.comments))).toEqual([[r.id]]);
    expect(rest.map((e) => e.comment.id)).toEqual([plain.id]);
  });

  it("keeps a resolution event with no thread in the conversation", () => {
    const orphan = event(999_999, 10);
    const { threads, rest } = reconstructThreads([orphan], context);
    expect(threads).toEqual([]);
    expect(rest.map((e) => [e.comment.id, e.classification.state])).toEqual([[orphan.id, "valid"]]);
  });

  it("leaves comments without valid metadata in the conversation, classified", () => {
    const plain = issueComment("hi");
    const damaged = issueComment("x <!-- rendered-review:v1:%% -->");
    const { threads, rest } = reconstructThreads([plain, damaged], context);
    expect(threads).toEqual([]);
    expect(rest.map((e) => e.classification.state)).toEqual(["native", "damaged"]);
  });
});
