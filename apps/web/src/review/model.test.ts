// SPDX-License-Identifier: AGPL-3.0-only
import type { NativeAnchor, NativeThread, Resolution } from "@rendered-review/review-domain";
import { describe, expect, it } from "vitest";
import {
  anchorLabel,
  blobUrl,
  connectorPath,
  filterCounts,
  isEdited,
  layoutCards,
  relativeTime,
  suggestionOriginal,
  threadState,
} from "./model";

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
