// SPDX-License-Identifier: AGPL-3.0-only
// Decides how a comment on a source range is published to GitHub: a native review comment on
// diff lines, a file-level review comment, or a PR conversation comment. Pure.

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
