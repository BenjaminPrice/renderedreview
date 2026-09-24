// SPDX-License-Identifier: AGPL-3.0-only
// Annotation-aware projection and placement: application threads and annotated review comments.
import { composeCommentBody, type RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import { annotation, at, BLOB, context, DOC, issueComment, OLD_BLOB, reviewComment, target } from "./fixtures.js";
import { anchorLines, type NativeThread, placeThreads, projectReview } from "./projection.js";

const body = (a: RenderedReviewAnnotationV1, text = "Should this define a retry limit?") =>
  composeCommentBody({ annotation: a, comment: text, location: "conversation" });
const project = (issueComments = [issueComment("")], reviewComments = [reviewComment("")]) =>
  projectReview({ repository: context, reviewComments, reviews: [], issueComments });

describe("projectReview with application comments", () => {
  it("puts application threads in the document, not the conversation or timeline", () => {
    const root = issueComment(body(annotation()), { createdAt: at(0) });
    const reply = issueComment(
      body(annotation({ motivation: "replying", replyTo: String(root.id), threadId: String(root.id) })),
      { createdAt: at(10) },
    );
    const plain = issueComment("Plain conversation comment", { createdAt: at(5) });
    const p = project([root, reply, plain], []);
    expect(p.threads.map((t) => [t.id, t.comments.map((c) => c.id)])).toEqual([
      [`app:${root.id}`, [root.id, reply.id]],
    ]);
    expect(p.conversation.map((e) => e.comment.id)).toEqual([plain.id]);
    expect(p.timeline.map((i) => i.kind === "comment" && i.entry.comment.id)).toEqual([plain.id]);
    expect(p.unresolvedByPath).toEqual({ "doc.md": 1 });
  });

  it("keeps damaged and unsupported metadata in the conversation with its classification", () => {
    const damaged = issueComment(body(target({ pullRequest: 8 })));
    const unsupported = issueComment("Hi <!-- rendered-review:v9:e30= -->");
    const plain = issueComment("hello");
    const p = project([damaged, unsupported, plain], []);
    expect(p.threads).toEqual([]);
    expect(p.conversation.map((e) => e.metadata?.state)).toEqual(["damaged", "unsupported", undefined]);
    // Falls back to the native location: the permalink in the body is still an inferred location.
    expect(p.conversation[0]!.inferred).toHaveLength(1);
  });

  it("prefers a review comment's annotation when it agrees with the GitHub line", () => {
    const a = annotation();
    const c = reviewComment(body(a), { line: 3 });
    const [t] = project([], [c]).threads;
    expect(t!.anchor).toMatchObject({
      type: "annotation",
      annotation: a,
      fallback: { kind: "github-line", startLine: 3 },
    });
    expect(t!.metadata?.[c.id]?.state).toBe("valid");
  });

  it("keeps the GitHub line when the annotation points elsewhere", () => {
    const [t] = project([], [reviewComment(body(annotation()), { line: 9 })]).threads;
    expect(t!.anchor).toMatchObject({ type: "current", kind: "github-line", startLine: 9 });
  });

  it("keeps the GitHub location and records damaged metadata on review comments", () => {
    const c = reviewComment(body(target({ repositoryId: 1 })));
    const [t] = project([], [c]).threads;
    expect(t!.anchor.type).toBe("current");
    expect(t!.metadata?.[c.id]?.state).toBe("damaged");
  });
});

describe("placeThreads with annotations", () => {
  const head = renderMarkdown(DOC);
  const appThread = (a = annotation(), fallback?: NativeThread["anchor"]): NativeThread => ({
    id: "app:1",
    path: "doc.md",
    comments: [issueComment(body(a))],
    resolution: "unresolved",
    anchor: { type: "annotation", annotation: a, ...(fallback && { fallback }) },
  });
  const line = {
    type: "current",
    kind: "github-line",
    side: "RIGHT",
    startLine: 3,
    endLine: 3,
    commitOid: "a".repeat(40),
  } as const;

  it("places a current-blob annotation on its exact words and the enclosing block", () => {
    const [p] = placeThreads([appThread()], "doc.md", { head, blob: { oid: BLOB, source: DOC } });
    expect(p!.blocks.map((b) => b.text)).toEqual(["The system retries failed requests indefinitely."]);
    expect(p!.range).toEqual({
      kind: "annotation",
      sourceRange: { startLine: 3, startColumn: 12, endLine: 3, endColumn: 35 },
      textQuote: { exact: "retries failed requests", prefix: "The system ", suffix: " indefinitely." },
    });
    expect(p!.reason).toBeUndefined();
  });

  it("leaves an annotation on an older blob unplaced until re-anchoring", () => {
    const [p] = placeThreads([appThread(target({ blobOid: OLD_BLOB }))], "doc.md", {
      head,
      blob: { oid: BLOB, source: DOC },
    });
    expect(p).toMatchObject({ blocks: [], reason: "Document changed since this comment — re-anchoring pending" });
    expect(p!.range).toBeUndefined();
  });

  it("uses the GitHub line of an annotated review comment when the blob differs", () => {
    const [p] = placeThreads([appThread(target({ blobOid: OLD_BLOB }), line)], "doc.md", {
      head,
      blob: { oid: BLOB, source: DOC },
    });
    expect(p!.blocks).toHaveLength(1);
    expect(p!.range).toBeUndefined();
    expect(p!.reason).toBeUndefined();
  });

  it("marks the metadata damaged when the quote does not match the blob, and falls back", () => {
    const wrong = annotation();
    wrong.target.selectors = wrong.target.selectors.map((s) =>
      s.type === "TextQuoteSelector" ? { ...s, exact: "retries all requests" } : s,
    );
    const [unplaced, fallback] = placeThreads([appThread(wrong), appThread(wrong, line)], "doc.md", {
      head,
      blob: { oid: BLOB, source: DOC },
    });
    expect(unplaced).toMatchObject({ blocks: [], damaged: expect.stringContaining("quoted text") });
    expect(fallback!.blocks).toHaveLength(1);
    expect(fallback!.damaged).toBeDefined();
  });

  it("gives the lines of every anchor kind", () => {
    expect(anchorLines({ type: "file" })).toBeUndefined();
    expect(anchorLines(line)).toEqual({ startLine: 3, endLine: 3 });
    const multi = target({});
    multi.target.selectors = multi.target.selectors.map((s) =>
      s.type === "MarkdownSourceRangeSelector" ? { ...s, startLine: 3, endLine: 6, endColumn: 1 } : s,
    );
    // A range ending at column 1 does not include that line.
    expect(anchorLines({ type: "annotation", annotation: multi })).toEqual({ startLine: 3, endLine: 5 });
  });
});
