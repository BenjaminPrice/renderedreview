// SPDX-License-Identifier: AGPL-3.0-only
// Decides how a comment on a source range is published to GitHub: a native review comment on
// diff lines, a file-level review comment, or a PR conversation comment. Pure.
import type { ChangedFile } from "@rendered-review/github-integration";

/** Lines GitHub accepts review comments on within one diff hunk. */
export interface Hunk {
  /** Head line numbers of added and context lines. */
  right: Set<number>;
  /** Base line numbers of deleted and context lines. */
  left: Set<number>;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses a unified diff `patch` (as returned per file by GitHub) into commentable lines per hunk. */
export const parsePatch = (patch: string | undefined): Hunk[] => {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of (patch ?? "").split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      hunk = { right: new Set(), left: new Set() };
      hunks.push(hunk);
      [oldLine, oldLeft, newLine, newLeft] = [+header[1]!, +(header[2] ?? 1), +header[3]!, +(header[4] ?? 1)];
      continue;
    }
    // Count-bounded, so a trailing newline or other text outside a hunk is ignored.
    if (!hunk || (oldLeft <= 0 && newLeft <= 0) || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      hunk.right.add(newLine++);
      newLeft--;
    } else if (line.startsWith("-")) {
      hunk.left.add(oldLine++);
      oldLeft--;
    } else {
      // Context; a blank context line may arrive with its leading space stripped.
      hunk.right.add(newLine++);
      hunk.left.add(oldLine++);
      newLeft--;
      oldLeft--;
    }
  }
  return hunks;
};

export type Side = "LEFT" | "RIGHT";

/** `startLine`/`startSide` are set only for multi-line ranges; they map to GitHub's `start_line`/`start_side`. */
export type Representation =
  | { kind: "review-line"; line: number; side: Side; startLine?: number; startSide?: Side; reason: string }
  | { kind: "review-file"; reason: string }
  | { kind: "conversation"; reason: string };

export interface RepresentationInput {
  /** The PR's entry for the file; absent when the PR doesn't change it. */
  file: ChangedFile | undefined;
  /** 1-based inclusive source lines: head lines on RIGHT, base lines on LEFT. */
  range: { startLine: number; endLine: number };
  /** Defaults to LEFT for deleted files, otherwise RIGHT. */
  side?: Side;
}

/**
 * Picks the narrowest GitHub representation that covers the whole range. A native line comment
 * needs every line of the range on one side of a single hunk (GitHub rejects multi-line comments
 * whose start line is in another hunk); a partly covered range falls back to a file comment
 * rather than silently shrinking.
 */
export const chooseRepresentation = ({ file, range, side }: RepresentationInput): Representation => {
  if (!file)
    return { kind: "conversation", reason: "Will post as PR conversation comment · file isn't changed in this PR" };
  const { startLine, endLine } = range;
  const s = side ?? (file.status === "removed" ? "LEFT" : "RIGHT");
  const single = startLine === endLine;
  const lines = single ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const fileComment = (why: string): Representation => ({
    kind: "review-file",
    reason: `Will post as file comment · ${why}`,
  });

  const hunks = parsePatch(file.patch).map((h) => (s === "RIGHT" ? h.right : h.left));
  if (hunks.length === 0)
    return fileComment(file.changes === 0 ? "this file has no line changes" : "this file's diff isn't available");
  const inRange = (has: (n: number) => boolean) => {
    for (let n = startLine; n <= endLine; n++) if (!has(n)) return false;
    return true;
  };
  if (hunks.some((h) => inRange((n) => h.has(n)))) {
    return {
      kind: "review-line",
      ...(!single && { startLine, startSide: s }),
      line: endLine,
      side: s,
      reason: `Will post as native review comment · ${lines} ${single ? "is" : "are"} in this PR's diff`,
    };
  }
  if (inRange((n) => hunks.some((h) => h.has(n)))) return fileComment(`${lines} span more than one diff hunk`);
  return fileComment(single ? `${lines} isn't in the diff` : `${lines} aren't all in the diff`);
};

/** GitHub suggested changes apply only to head lines, so only RIGHT line comments can carry one; others use an extended suggestion. */
export const suggestionEligible = (representation: Representation): boolean =>
  representation.kind === "review-line" && representation.side === "RIGHT";
