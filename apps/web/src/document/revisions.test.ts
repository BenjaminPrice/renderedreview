// SPDX-License-Identifier: AGPL-3.0-only
import type { NativeThread } from "@rendered-review/review-domain";
import { describe, expect, it } from "vitest";
import { annotation, appThread, comment, lineAnchor, thread } from "../review/fixtures";
import type { DocEntry } from "./docs";
import { revisionOptions, revisionSource } from "./revisions";

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const entry = (over: Partial<DocEntry> = {}): DocEntry =>
  ({ path: "docs/guide.md", status: "modified", oid: "f".repeat(40), ...over }) as DocEntry;
const onCommit = (commitOid: string, path = "docs/guide.md", blobOid = "c".repeat(40)): NativeThread => {
  const a = annotation();
  return appThread(undefined, {
    path,
    anchor: { type: "annotation", annotation: { ...a, target: { ...a.target, path, commitOid, blobOid } } },
  });
};
const nativeOn = (originalCommitOid: string) =>
  thread("n", lineAnchor(3, 3, "outdated", originalCommitOid), "unknown", [comment({ originalCommitOid })]);

describe("revisionSource", () => {
  it("reads an annotation's own blob, at its own path, when one was written on the revision", () => {
    const renamed = entry({ status: "renamed", previousPath: "old/guide.md" });
    expect(revisionSource([onCommit(A, "old/guide.md")], renamed, A, BASE)).toEqual({
      commitOid: A,
      blobOid: "c".repeat(40),
      path: "old/guide.md",
    });
  });

  it("otherwise reads by path: the old path at the base, else the current one with the old as fallback", () => {
    const renamed = entry({ status: "renamed", previousPath: "old/guide.md" });
    expect(revisionSource([], renamed, BASE, BASE)).toEqual({ commitOid: BASE, path: "old/guide.md" });
    expect(revisionSource([], renamed, A, BASE)).toEqual({
      commitOid: A,
      path: "docs/guide.md",
      fallbackPath: "old/guide.md",
    });
    expect(revisionSource([onCommit(A, "elsewhere.md")], entry(), A, BASE)).toEqual({
      commitOid: A,
      path: "docs/guide.md",
    });
  });
});

describe("revisionOptions", () => {
  const commits = [
    { oid: A, title: "First", committedAt: "2026-01-01T00:00:00Z", htmlUrl: "" },
    { oid: B, title: "Second", committedAt: "2026-01-02T00:00:00Z", htmlUrl: "" },
  ];

  it("lists current, then the commits comments were written on (newest first), then base", () => {
    const threads = [onCommit(A), nativeOn(B), onCommit(A), onCommit(HEAD), onCommit(B, "other.md")];
    expect(revisionOptions({ entry: entry(), current: HEAD, base: BASE, threads, commits })).toEqual([
      { oid: HEAD, label: `Current · 1111111` },
      { oid: B, label: "Original · bbbbbbb · Second" },
      { oid: A, label: "Original · aaaaaaa · First" },
      { oid: BASE, label: "Base · 2222222" },
    ]);
  });

  it("keeps a linked revision no comment names, and has no base for added or deleted documents", () => {
    const x = "9".repeat(40);
    expect(
      revisionOptions({
        entry: entry({ status: "added" }),
        current: HEAD,
        base: BASE,
        threads: [],
        commits,
        selected: x,
      }),
    ).toEqual([
      { oid: HEAD, label: "Current · 1111111" },
      { oid: x, label: "Original · 9999999" },
    ]);
    expect(
      revisionOptions({ entry: entry({ status: "deleted" }), current: BASE, base: BASE, threads: [], commits }),
    ).toEqual([{ oid: BASE, label: "Base · 2222222" }]);
  });
});
