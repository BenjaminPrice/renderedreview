// SPDX-License-Identifier: AGPL-3.0-only
// Earlier revisions of a document: which ones the revision selector offers, and where to read one.
import type { PullRequestCommit } from "@rendered-review/github-integration";
import type { NativeThread } from "@rendered-review/review-domain";
import type { DocEntry } from "./docs";

/** Where to read a document at `commitOid`: its blob when known, else the file by path. */
export interface RevisionSource {
  commitOid: string;
  /** Known when an annotation was written on this revision; preferred, as it survives renames. */
  blobOid?: string;
  path: string;
  /** Try this path when `path` does not exist at the commit (a renamed file's old path). */
  fallbackPath?: string;
}

const paths = (entry: DocEntry) => [entry.path, ...(entry.previousPath ? [entry.previousPath] : [])];

/** The commit a thread on this document was first written on. */
function writtenOn(thread: NativeThread): string | undefined {
  if (thread.anchor.type === "annotation") return thread.anchor.annotation.target.commitOid;
  const root = thread.comments[0];
  return root && "originalCommitOid" in root ? root.originalCommitOid : undefined;
}

export function revisionSource(
  threads: NativeThread[],
  entry: DocEntry,
  commitOid: string,
  baseSha: string,
): RevisionSource {
  for (const { anchor } of threads) {
    if (anchor.type !== "annotation") continue;
    const { target } = anchor.annotation;
    if (target.commitOid === commitOid && paths(entry).includes(target.path))
      return { commitOid, blobOid: target.blobOid, path: target.path };
  }
  const old = entry.previousPath;
  if (commitOid === baseSha && old) return { commitOid, path: old };
  return { commitOid, path: entry.path, ...(old && { fallbackPath: old }) };
}

export interface RevisionOption {
  oid: string;
  label: string;
}

/**
 * The revisions offered for a document: the one shown by default, the commits its comments were
 * written on (newest first, by their order in the pull request), and the base. `selected` is
 * listed too when a link names a revision nothing else does.
 */
export function revisionOptions({
  entry,
  current,
  base,
  threads,
  commits,
  selected,
}: {
  entry: DocEntry;
  /** Commit of the default view: the head, or the base for a deleted document. */
  current: string;
  base: string;
  threads: NativeThread[];
  commits: PullRequestCommit[];
  selected?: string;
}): RevisionOption[] {
  const short = (oid: string) => oid.slice(0, 7);
  const onDoc = threads.filter((t) => paths(entry).includes(t.path));
  const originals = new Set(onDoc.flatMap((t) => writtenOn(t) ?? []));
  if (selected) originals.add(selected);
  originals.delete(current);
  originals.delete(base);
  const order = new Map(commits.map((c, i) => [c.oid, i]));
  const sorted = [...originals].sort((a, b) => (order.get(b) ?? -1) - (order.get(a) ?? -1));
  const hasBase = entry.status !== "added" && entry.status !== "deleted";
  const title = (oid: string) => commits.find((c) => c.oid === oid)?.title;
  return [
    { oid: current, label: `${current === base ? "Base" : "Current"} · ${short(current)}` },
    ...sorted.map((oid) => ({ oid, label: [`Original · ${short(oid)}`, title(oid)].filter(Boolean).join(" · ") })),
    ...(hasBase ? [{ oid: base, label: `Base · ${short(base)}` }] : []),
  ];
}
