// SPDX-License-Identifier: AGPL-3.0-only
// Pure document-list and change logic for the PR review page.
import type { ChangedFile, Tree } from "@rendered-review/github-integration";
import { diffArrays } from "diff";
import { isMarkdownPath } from "../pr-url";

export type DocStatus = "added" | "modified" | "renamed" | "deleted" | "unchanged";

export interface DocEntry {
  path: string;
  status: DocStatus;
  /** Renamed files: the path at the base revision. */
  previousPath?: string;
  /** Blob to show: the head blob, or the base blob for a deleted file. */
  oid: string;
}

export const STATUS_LETTER: Record<DocStatus, string> = {
  added: "A",
  modified: "M",
  renamed: "R",
  deleted: "D",
  unchanged: "·",
};

function docStatus(file: ChangedFile): Exclude<DocStatus, "unchanged"> {
  if (file.status === "added" || file.status === "copied") return "added";
  if (file.status === "removed") return "deleted";
  if (file.status === "renamed") return "renamed";
  return "modified";
}

/** Changed Markdown documents in GitHub's order, plus the non-Markdown files that only link out. */
export function changedDocs(files: ChangedFile[]): { docs: DocEntry[]; otherCount: number } {
  const docs = files
    .filter((f) => isMarkdownPath(f.path))
    .map((f) => ({
      path: f.path,
      status: docStatus(f),
      ...(f.previousPath && { previousPath: f.previousPath }),
      // For a removed file GitHub reports the base blob.
      oid: f.blobOid,
    }));
  return { docs, otherCount: files.length - docs.length };
}

/** Every Markdown blob at the head commit, sorted by path, with its change status. */
export function allDocs(headTree: Tree, changed: DocEntry[]): DocEntry[] {
  const byPath = new Map(changed.map((d) => [d.path, d]));
  return headTree.entries
    .filter((e) => e.type === "blob" && isMarkdownPath(e.path))
    .map((e) => byPath.get(e.path) ?? { path: e.path, status: "unchanged" as const, oid: e.oid })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type ChangeKind = "added" | "modified";

/** A 1-based, inclusive range of head lines. */
export interface LineChange {
  start: number;
  end: number;
  /** `added` for pure insertions, `modified` when base lines were replaced. */
  kind: ChangeKind;
}

/** Source lines, 1-based line n at index n - 1. */
export const splitLines = (text: string) =>
  text === "" ? [] : text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");

/**
 * Head line ranges that differ from base. Uses `diff` (Myers, O(ND)); a naive LCS table is
 * O(n·m) memory, too much for long documents with scattered edits.
 */
export function changedLines(base: string, head: string): LineChange[] {
  const out: LineChange[] = [];
  let line = 1;
  let removed = false;
  for (const part of diffArrays(splitLines(base), splitLines(head))) {
    if (part.removed) {
      removed = true;
      continue;
    }
    if (part.added) out.push({ start: line, end: line + part.count - 1, kind: removed ? "modified" : "added" });
    line += part.count;
    removed = false;
  }
  return out;
}

/** GitHub permalink to a file, or one of its lines, at a commit. */
export function sourceUrl(
  { host, owner, repo }: { host: string; owner: string; repo: string },
  sha: string,
  path: string,
  line?: number,
): string {
  const file = path.split("/").map(encodeURIComponent).join("/");
  return `https://${host}/${owner}/${repo}/blob/${sha}/${file}${line === undefined ? "" : `#L${line}`}`;
}
