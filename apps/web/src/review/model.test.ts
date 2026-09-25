// SPDX-License-Identifier: AGPL-3.0-only
import type {
  NativeAnchor,
  NativeThread,
  ReanchorState,
  Resolution,
  ThreadPlacement,
} from "@rendered-review/review-domain";
import { describe, expect, it } from "vitest";
import {
  anchorLabel,
  blobUrl,
  connectorPath,
  filterCounts,
  isEdited,
  layoutCards,
  originalRevision,
  placementState,
  relativeTime,
  repairTarget,
  suggestionOriginal,
  threadState,
} from "./model";
import { annotation, appThread, comment, HEAD, issueComment, lineAnchor, thread as nativeThread } from "./fixtures";

const line = (type: "current" | "outdated", startLine: number, endLine: number, side: "LEFT" | "RIGHT" = "RIGHT") =>
  ({ type, kind: "github-line", side, startLine, endLine, commitOid: "a".repeat(40) }) as NativeAnchor;
const thread = (resolution: Resolution, anchor: NativeAnchor) =>
  ({ id: "t", path: "doc.md", comments: [], resolution, anchor }) as NativeThread;

describe("thread state and filter counts", () => {
  it("buckets resolved first, then outdated, else current", () => {
    expect(threadState(thread("resolved", line("outdated", 1, 1)))).toBe("resolved");
    expect(threadState(thread("unresolved", line("outdated", 1, 1)))).toBe("outdated");
    expect(threadState(thread("unknown", { type: "file" }))).toBe("current");
  });

  it("counts every bucket", () => {
    const threads = [
      thread("unknown", line("current", 1, 2)),
      thread("unresolved", { type: "file" }),
      thread("resolved", line("current", 3, 3)),
      thread("unresolved", line("outdated", 4, 4)),
    ];
    expect(filterCounts(threads)).toEqual({ current: 2, resolved: 1, outdated: 1, historical: 0 });
  });
});

describe("placement state and original revision", () => {
  const OLD = "b".repeat(40);
  const reanchored = (state: ReanchorState, resolution: Resolution = "unresolved"): ThreadPlacement => ({
    thread: appThread(undefined, { resolution }),
    blocks: [],
    reanchor: { state, evidence: "none", confidence: 0, candidates: [] },
  });

  it("buckets an annotation whose words are only in an earlier revision as historical, unless resolved", () => {
    expect(placementState(reanchored("historical-only"))).toBe("historical");
    expect(placementState(reanchored("historical-only", "resolved"))).toBe("resolved");
    expect(placementState(reanchored("unavailable"))).toBe("current");
    expect(placementState({ thread: thread("unknown", line("outdated", 1, 1)), blocks: [] })).toBe("outdated");
  });

  it("names the revision a thread was written on when it is not shown as it was", () => {
    expect(
      originalRevision({
        thread: thread("unknown", { ...line("outdated", 1, 1), commitOid: OLD } as NativeAnchor),
        blocks: [],
      }),
    ).toBe(OLD);
    // The fixture annotation was written on HEAD.
    for (const state of ["outdated", "historical-only", "ambiguous", "moved"] as const)
      expect(originalRevision(reanchored(state))).toBe(HEAD);
    // Gone from GitHub, on its own blob, or a current line comment: nothing to open.
    expect(originalRevision(reanchored("unavailable"))).toBeUndefined();
    expect(originalRevision({ thread: appThread(), blocks: [] })).toBeUndefined();
    expect(originalRevision({ thread: thread("unknown", line("current", 1, 1)), blocks: [] })).toBeUndefined();
  });
});

describe("isEdited", () => {
  it("ignores GitHub's creation bump but flags later edits", () => {
    expect(isEdited({ createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:02Z" })).toBe(false);
    expect(isEdited({ createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:05:00Z" })).toBe(true);
  });
});

describe("labels and links", () => {
  it("labels line ranges, single lines, base side and file scope", () => {
    expect(anchorLabel(line("current", 31, 39))).toBe("GitHub line comment · L31–L39");
    expect(anchorLabel(line("current", 7, 7))).toBe("GitHub line comment · L7");
    expect(anchorLabel(line("current", 7, 7, "LEFT"))).toBe("GitHub line comment · L7 (base)");
    expect(anchorLabel({ type: "file" })).toBe("File-level review comment");
  });

  it("builds a blob permalink with an encoded path", () => {
    const repo = { host: "github.com", owner: "o", name: "r" };
    expect(blobUrl(repo, "abc", "docs/my file.md", { startLine: 3, endLine: 5 })).toBe(
      "https://github.com/o/r/blob/abc/docs/my%20file.md#L3-L5",
    );
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(relativeTime("2026-01-01T21:00:00Z", now, "en")).toBe("3h ago");
    expect(relativeTime("2026-01-01T23:59:50Z", now, "en")).toBe("now");
  });

  it("uses one numeric style for every distance, never words like 'last yr.'", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(relativeTime("2025-01-01T00:00:00Z", now, "en")).toBe("1y ago");
    expect(relativeTime("2024-01-01T00:00:00Z", now, "en")).toBe("2y ago");
    expect(relativeTime("2026-01-01T00:00:00Z", now, "en")).toBe("1d ago");
  });
});

describe("suggestionOriginal", () => {
  it("takes the last head-side lines of the hunk", () => {
    const hunk = "@@ -1,4 +1,4 @@\n context\n-old line\n+new a\n+new b";
    expect(suggestionOriginal(hunk, 2)).toEqual(["new a", "new b"]);
    expect(suggestionOriginal(hunk, 3)).toEqual(["context", "new a", "new b"]);
  });
});

describe("layoutCards", () => {
  it("aligns to anchors and pushes colliding cards down without overlap", () => {
    const { tops, height } = layoutCards(
      [
        { id: "b", anchorTop: 110, height: 80 },
        { id: "a", anchorTop: 100, height: 50 },
        { id: "c", anchorTop: 400, height: 20 },
        { id: "d", anchorTop: -30, height: 10 },
      ],
      10,
    );
    expect(tops.get("d")).toBe(0);
    expect(tops.get("a")).toBe(100);
    expect(tops.get("b")).toBe(160);
    expect(tops.get("c")).toBe(400);
    expect(height).toBe(420);
  });

  it("is empty for no items", () => {
    expect(layoutCards([], 10).height).toBe(0);
  });
});

describe("connectorPath", () => {
  it("draws an elbow via a staggered lane", () => {
    const w = { id: "t", cardX: 500, cardY: 40, anchorX: 300, anchorY: 20 };
    expect(connectorPath(w, 0)).toBe("M500 40H490V20H300");
    expect(connectorPath(w, 2)).toBe("M500 40H480V20H300");
  });

  it("keeps the lane right of the anchor dot", () => {
    expect(connectorPath({ id: "t", cardX: 310, cardY: 0, anchorX: 300, anchorY: 50 }, 4)).toBe("M310 0H305V50H300");
  });
});

describe("repairTarget: repairing the anchor of the viewer's own comment", () => {
  const ME = 1; // alice, the fixtures' author
  const unplaced = (state: ReanchorState) =>
    ({ state, evidence: "none", confidence: 0, candidates: [] }) as ThreadPlacement["reanchor"];
  const damagedMeta = (c: { id: number }) => ({ [c.id]: { state: "damaged" as const, reason: "x", edited: false } });

  it("is offered on the viewer's application thread whose words are not in the current document", () => {
    for (const state of ["historical-only", "unavailable", "outdated", "ambiguous"] as const) {
      const t = appThread();
      const target = repairTarget({ thread: t, blocks: [], reanchor: unplaced(state) }, ME);
      expect(target).toMatchObject({ comment: t.comments[0], commentType: "issue", location: "conversation" });
      expect(target?.annotation).toEqual(annotation());
    }
  });

  it("is offered when the annotation doesn't match the document it names", () => {
    expect(repairTarget({ thread: appThread(), blocks: [], damaged: "The quote doesn't match" }, ME)).toBeDefined();
  });

  it("is offered on the viewer's current line comment with damaged or unsupported metadata, within its GitHub lines", () => {
    const c = comment({ body: "> old\n\nText\n\n<!-- rendered-review:v1:!! -->" });
    const t = { ...nativeThread("n", lineAnchor(2, 3), "unresolved", [c]), metadata: damagedMeta(c) };
    expect(repairTarget({ thread: t, blocks: [] }, ME)).toEqual({
      comment: c,
      commentType: "review",
      location: "review-line",
      lines: { startLine: 2, endLine: 3 },
    });
    const v2 = comment({ body: "> old\n\nText\n\n<!-- rendered-review:v2:e30= -->" });
    const unsupported = { state: "unsupported" as const, edited: false };
    const t2 = { ...nativeThread("n", lineAnchor(3), "unresolved", [v2]), metadata: { [v2.id]: unsupported } };
    expect(repairTarget({ thread: t2, blocks: [] }, ME)).toBeDefined();
    // An unsupported version without a quote: nothing this version knows how to rewrite.
    const bare = comment({ body: "Text\n\n<!-- rendered-review:v2:e30= -->" });
    const t3 = { ...nativeThread("n", lineAnchor(3), "unresolved", [bare]), metadata: { [bare.id]: unsupported } };
    expect(repairTarget({ thread: t3, blocks: [] }, ME)).toBeUndefined();
  });

  it("is not offered on someone else's comment, even with the same login", () => {
    const other = issueComment("Needs a limit.", { author: { login: "alice", id: 2, nodeId: "U2", type: "User" } });
    expect(
      repairTarget({ thread: appThread([other]), blocks: [], reanchor: unplaced("historical-only") }, ME),
    ).toBeUndefined();
    expect(
      repairTarget({ thread: appThread(), blocks: [], reanchor: unplaced("historical-only") }, undefined),
    ).toBeUndefined();
  });

  it("is not offered when the anchor is fine, or on a GitHub line comment without metadata", () => {
    const placed = appThread();
    expect(repairTarget({ thread: placed, blocks: [], range: {} as ThreadPlacement["range"] }, ME)).toBeUndefined();
    expect(repairTarget({ thread: nativeThread("n", lineAnchor(3)), blocks: [] }, ME)).toBeUndefined();
  });

  it("is not offered where a new annotation would not move the comment: file, outdated or base-side comments", () => {
    for (const anchor of [
      { type: "file" } as const,
      lineAnchor(3, 3, "outdated"),
      { ...lineAnchor(3), side: "LEFT" as const },
    ]) {
      const c = comment({ body: "Text\n\n<!-- rendered-review:v1:!! -->" });
      const t = { ...nativeThread("n", anchor, "unresolved", [c]), metadata: damagedMeta(c) };
      expect(repairTarget({ thread: t, blocks: [] }, ME)).toBeUndefined();
    }
  });
});
