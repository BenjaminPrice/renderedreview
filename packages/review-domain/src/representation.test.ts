// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { parsePatch } from "./representation.js";

const lines = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("parsePatch", () => {
  it("collects RIGHT (added + context) and LEFT (deleted + context) lines per hunk", () => {
    const patch = ["@@ -10,4 +10,5 @@ heading", " a", "-b", "+B", "+B2", " c", " d"].join("\n");
    const [hunk, ...rest] = parsePatch(patch);
    expect(rest).toEqual([]);
    expect(lines(hunk!.right)).toEqual([10, 11, 12, 13, 14]);
    expect(lines(hunk!.left)).toEqual([10, 11, 12, 13]);
  });

  it("keeps hunks separate", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-x", "+X", " y", "@@ -40 +40 @@", "-z", "+Z"].join("\n");
    const hunks = parsePatch(patch);
    expect(hunks.map((h) => lines(h.right))).toEqual([[1, 2], [40]]);
    expect(hunks.map((h) => lines(h.left))).toEqual([[1, 2], [40]]);
  });

  it("ignores the no-newline marker, CRLF line endings and a trailing newline", () => {
    const patch = "@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n\\ No newline at end of file\r\n+b\r\n\\ No newline at end of file\r\n";
    const [hunk] = parsePatch(patch);
    expect(lines(hunk!.right)).toEqual([1, 2]);
    expect(lines(hunk!.left)).toEqual([1, 2]);
  });

  it("treats an empty line inside a hunk as blank context", () => {
    const patch = ["@@ -1,3 +1,3 @@", " a", "", "-c", "+C"].join("\n");
    expect(lines(parsePatch(patch)[0]!.right)).toEqual([1, 2, 3]);
  });

  it("handles an added file (-0,0) and a deleted file (+0,0)", () => {
    expect(lines(parsePatch("@@ -0,0 +1,2 @@\n+a\n+b")[0]!.right)).toEqual([1, 2]);
    const deleted = parsePatch("@@ -1,2 +0,0 @@\n-a\n-b")[0]!;
    expect(lines(deleted.left)).toEqual([1, 2]);
    expect(lines(deleted.right)).toEqual([]);
  });

  it("returns no hunks for a missing or empty patch", () => {
    expect(parsePatch(undefined)).toEqual([]);
    expect(parsePatch("")).toEqual([]);
  });
});
