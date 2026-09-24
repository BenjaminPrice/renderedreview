// SPDX-License-Identifier: AGPL-3.0-only
import type { ChangedFile } from "@rendered-review/github-integration";
import { describe, expect, it } from "vitest";
import { chooseRepresentation, parsePatch, suggestionEligible, type Representation } from "./representation.js";

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
    const patch =
      "@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n\\ No newline at end of file\r\n+b\r\n\\ No newline at end of file\r\n";
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

const file = (o: Partial<ChangedFile>): ChangedFile => ({
  path: "docs/guide.md",
  status: "modified",
  blobOid: "f".repeat(40),
  additions: 1,
  deletions: 1,
  changes: 2,
  ...o,
});

// Hunk 1: RIGHT 20-26 (24 added), LEFT 20-26 (24 deleted). Hunk 2: RIGHT 40-42, LEFT 40-41.
const MODIFIED = [
  "@@ -20,7 +20,7 @@ ## Setup",
  " l20",
  " l21",
  " l22",
  " l23",
  "-old24",
  "+new24",
  " l25",
  " l26",
  "@@ -40,2 +40,3 @@",
  " l40",
  "+new41",
  " l42",
].join("\n");

const NATIVE = "Will post as native review comment";
const FILE = "Will post as file comment";

describe("chooseRepresentation", () => {
  const cases: {
    name: string;
    file: ChangedFile | undefined;
    range: [number, number];
    side?: "LEFT" | "RIGHT";
    expected: Representation;
  }[] = [
    {
      name: "modified file, changed line",
      file: file({ patch: MODIFIED }),
      range: [24, 24],
      expected: { kind: "review-line", line: 24, side: "RIGHT", reason: `${NATIVE} · line 24 is in this PR's diff` },
    },
    {
      name: "modified file, context line",
      file: file({ patch: MODIFIED }),
      range: [21, 21],
      expected: { kind: "review-line", line: 21, side: "RIGHT", reason: `${NATIVE} · line 21 is in this PR's diff` },
    },
    {
      name: "modified file, multi-line range within one hunk",
      file: file({ patch: MODIFIED }),
      range: [22, 26],
      expected: {
        kind: "review-line",
        startLine: 22,
        startSide: "RIGHT",
        line: 26,
        side: "RIGHT",
        reason: `${NATIVE} · lines 22–26 are in this PR's diff`,
      },
    },
    {
      name: "modified file, line outside every hunk",
      file: file({ patch: MODIFIED }),
      range: [80, 80],
      expected: { kind: "review-file", reason: `${FILE} · line 80 isn't in the diff` },
    },
    {
      name: "modified file, range partly inside a hunk is not shrunk",
      file: file({ patch: MODIFIED }),
      range: [25, 28],
      expected: { kind: "review-file", reason: `${FILE} · lines 25–28 aren't all in the diff` },
    },
    {
      name: "modified file, range whose lines sit in two hunks",
      file: file({ patch: ["@@ -1,2 +1,2 @@", " a", "-b", "+B", "@@ -3,1 +3,1 @@", "-c", "+C"].join("\n") }),
      range: [2, 3],
      expected: { kind: "review-file", reason: `${FILE} · lines 2–3 span more than one diff hunk` },
    },
    {
      name: "modified file, base-side deleted line",
      file: file({ patch: MODIFIED }),
      range: [24, 24],
      side: "LEFT",
      expected: { kind: "review-line", line: 24, side: "LEFT", reason: `${NATIVE} · line 24 is in this PR's diff` },
    },
    {
      name: "modified file, base-side line that exists only on the head",
      file: file({ patch: MODIFIED }),
      range: [42, 42],
      side: "LEFT",
      expected: { kind: "review-file", reason: `${FILE} · line 42 isn't in the diff` },
    },
    {
      name: "modified file with a CRLF patch",
      file: file({ patch: MODIFIED.replaceAll("\n", "\r\n") }),
      range: [40, 42],
      expected: {
        kind: "review-line",
        startLine: 40,
        startSide: "RIGHT",
        line: 42,
        side: "RIGHT",
        reason: `${NATIVE} · lines 40–42 are in this PR's diff`,
      },
    },
    {
      name: "modified file, last line before a no-newline marker",
      file: file({ patch: "@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file" }),
      range: [1, 1],
      expected: { kind: "review-line", line: 1, side: "RIGHT", reason: `${NATIVE} · line 1 is in this PR's diff` },
    },
    {
      name: "added file",
      file: file({ status: "added", patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c" }),
      range: [1, 3],
      expected: {
        kind: "review-line",
        startLine: 1,
        startSide: "RIGHT",
        line: 3,
        side: "RIGHT",
        reason: `${NATIVE} · lines 1–3 are in this PR's diff`,
      },
    },
    {
      name: "deleted file comments on base lines",
      file: file({ status: "removed", patch: "@@ -1,2 +0,0 @@\n-a\n-b" }),
      range: [2, 2],
      expected: { kind: "review-line", line: 2, side: "LEFT", reason: `${NATIVE} · line 2 is in this PR's diff` },
    },
    {
      name: "renamed file with changes",
      file: file({ status: "renamed", previousPath: "docs/old.md", patch: MODIFIED }),
      range: [41, 41],
      expected: { kind: "review-line", line: 41, side: "RIGHT", reason: `${NATIVE} · line 41 is in this PR's diff` },
    },
    {
      name: "renamed file without line changes",
      file: file({ status: "renamed", previousPath: "docs/old.md", additions: 0, deletions: 0, changes: 0 }),
      range: [5, 5],
      expected: { kind: "review-file", reason: `${FILE} · this file has no line changes` },
    },
    {
      name: "file whose patch GitHub omitted (binary or too large)",
      file: file({ additions: 5000, deletions: 0, changes: 5000 }),
      range: [5, 5],
      expected: { kind: "review-file", reason: `${FILE} · this file's diff isn't available` },
    },
    {
      name: "file not changed by the PR",
      file: undefined,
      range: [5, 5],
      expected: {
        kind: "conversation",
        reason: "Will post as PR conversation comment · file isn't changed in this PR",
      },
    },
  ];

  it.each(cases)("$name", ({ file, range: [startLine, endLine], side, expected }) => {
    expect(chooseRepresentation({ file, range: { startLine, endLine }, ...(side && { side }) })).toEqual(expected);
  });
});

describe("suggestionEligible", () => {
  const reason = "";
  it.each<[string, Representation, boolean]>([
    ["RIGHT line comment", { kind: "review-line", line: 3, side: "RIGHT", reason }, true],
    ["LEFT line comment", { kind: "review-line", line: 3, side: "LEFT", reason }, false],
    ["file comment", { kind: "review-file", reason }, false],
    ["conversation comment", { kind: "conversation", reason }, false],
  ])("%s → native suggestion: %s", (_, representation, expected) => {
    expect(suggestionEligible(representation)).toBe(expected);
  });
});
