// SPDX-License-Identifier: AGPL-3.0-only
// Annotation-aware projection and placement: application threads and annotated review comments.
import { composeCommentBody, type RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import { annotation, at, BLOB, context, DOC, issueComment, OLD_BLOB, reviewComment, target } from "./fixtures.js";
import { anchorLines, displayBody, type NativeThread, placeThreads, projectReview } from "./projection.js";

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

  // The fixture annotation quotes DOC; these revisions change it.
  // Blob OIDs name content, and re-anchoring results are cached by them: one per revision here.
  let revision = 0;
  const place = (source: string, thread = appThread(target({ blobOid: OLD_BLOB }))) => {
    const oid = (++revision).toString(16).padStart(40, "e");
    return placeThreads([thread], "doc.md", { head: renderMarkdown(source), blob: { oid, source } })[0]!;
  };

  it("re-anchors an annotation from an older blob whose words did not move", () => {
    const p = place(DOC);
    expect(p.reanchor).toMatchObject({ state: "current", evidence: "same-range" });
    expect(p.range?.sourceRange).toEqual({ startLine: 3, startColumn: 12, endLine: 3, endColumn: 35 });
    expect(p.blocks.map((b) => b.text)).toEqual(["The system retries failed requests indefinitely."]);
    expect(p.reason).toBeUndefined();
  });

  it("places a moved annotation at its new words, marked moved", () => {
    const p = place(DOC.replace("# Reliability\n", "# Reliability\n\nAn introduction.\n"));
    expect(p.reanchor?.state).toBe("moved");
    expect(p.range?.sourceRange).toEqual({ startLine: 5, startColumn: 12, endLine: 5, endColumn: 35 });
    expect(p.blocks.map((b) => b.text)).toEqual(["The system retries failed requests indefinitely."]);
  });

  it("leaves an annotation whose words are gone unplaced, saying why", () => {
    const p = place("# Reliability\n\nThe system gives up after three attempts.\n");
    expect(p).toMatchObject({ blocks: [], reason: "The quoted text changed since this comment" });
    expect(p.reanchor?.state).toBe("outdated");
    expect(p.range).toBeUndefined();
  });

  it("never places an ambiguous annotation, and counts its candidates", () => {
    const p = place("# Reliability\n\nIt retries failed requests. It also retries failed requests.\n");
    expect(p).toMatchObject({ blocks: [], reason: "The quoted text now appears in 2 places" });
    expect(p.reanchor?.candidates).toHaveLength(2);
  });

  it("uses the GitHub line of an annotated review comment when re-anchoring cannot place it", () => {
    const p = place(
      "# Reliability\n\nThe system gives up after three attempts.\n",
      appThread(target({ blobOid: OLD_BLOB }), line),
    );
    expect(p.blocks).toHaveLength(1);
    expect(p.range).toBeUndefined();
    expect(p.reason).toBeUndefined();
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

describe("displayBody", () => {
  const a = annotation();
  const root = issueComment(body(a, "Root text"));
  const sameTarget = issueComment(body({ ...a, motivation: "replying", replyTo: String(root.id) }, "Reply text"));
  const otherQuote = target({});
  otherQuote.target.selectors = otherQuote.target.selectors.map((s) =>
    s.type === "TextQuoteSelector" ? { ...s, exact: "The system" } : s,
  );
  const otherTarget = issueComment(body({ ...otherQuote, motivation: "replying", replyTo: String(root.id) }, "Other"));
  const t = projectReview({
    repository: context,
    reviewComments: [],
    reviews: [],
    issueComments: [root, sameTarget, otherTarget],
  }).threads[0]!;

  it("hides the quote and permalink only once the anchor is verified", () => {
    // The marker stays; it is an HTML comment and renders as nothing.
    expect(displayBody(t, root, true)).toMatch(/^Root text\n\n<!-- rendered-review:v1:\S+ -->$/);
    expect(displayBody(t, root, false)).toBe(root.body);
  });

  it("hides them in replies only when they quote the same verified target", () => {
    expect(displayBody(t, sameTarget, true)).toMatch(/^Reply text\n\n<!--/);
    expect(displayBody(t, otherTarget, true)).toBe(otherTarget.body);
  });

  it("never touches comments without validated metadata", () => {
    const plain = issueComment("> retries failed requests\n\nplain");
    expect(displayBody(t, plain, true)).toBe(plain.body);
  });
});
