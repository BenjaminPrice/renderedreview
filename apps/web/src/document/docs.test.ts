// SPDX-License-Identifier: AGPL-3.0-only
import type { ChangedFile, Tree } from "@rendered-review/github-integration";
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import { allDocs, changedDocs, changedLines, selectedPath, sourceUrl } from "./docs";
import type { PrIdentity } from "../github/queries";
import { changeMarks, inAppDocLink } from "./document";

const file = (path: string, status: ChangedFile["status"], extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status,
  blobOid: `oid:${path}`,
  additions: 0,
  deletions: 0,
  changes: 0,
  ...extra,
});

const files = [
  file("docs/new.md", "added"),
  file("src/index.ts", "modified"),
  file("README.md", "modified"),
  file("docs/ops/runbook.md", "renamed", { previousPath: "docs/runbook.md" }),
  file("docs/legacy.markdown", "removed"),
  file("logo.svg", "added"),
];

describe("changedDocs", () => {
  it("keeps Markdown in GitHub's order with statuses, and counts the rest", () => {
    const { docs, otherCount } = changedDocs(files);
    expect(docs).toEqual([
      { path: "docs/new.md", status: "added", oid: "oid:docs/new.md" },
      { path: "README.md", status: "modified", oid: "oid:README.md" },
      {
        path: "docs/ops/runbook.md",
        status: "renamed",
        previousPath: "docs/runbook.md",
        oid: "oid:docs/ops/runbook.md",
      },
      { path: "docs/legacy.markdown", status: "deleted", oid: "oid:docs/legacy.markdown" },
    ]);
    expect(otherCount).toBe(2);
  });
});

describe("allDocs", () => {
  it("lists head Markdown blobs by path, marking changed ones", () => {
    const tree: Tree = {
      oid: "t",
      truncated: false,
      entries: [
        { path: "docs", mode: "040000", type: "tree", oid: "d" },
        { path: "docs/new.md", mode: "100644", type: "blob", oid: "oid:docs/new.md" },
        { path: "CONTRIBUTING.md", mode: "100644", type: "blob", oid: "c" },
        { path: "src/index.ts", mode: "100644", type: "blob", oid: "i" },
        { path: "vendor.md", mode: "160000", type: "commit", oid: "s" },
      ],
    };
    const { docs } = changedDocs(files);
    expect(allDocs(tree, docs).map((d) => [d.path, d.status])).toEqual([
      ["CONTRIBUTING.md", "unchanged"],
      ["docs/new.md", "added"],
    ]);
  });
});

describe("selectedPath", () => {
  const { docs } = changedDocs(files);
  it("prefers the doc search param, else the first changed doc", () => {
    expect(selectedPath("CONTRIBUTING.md", docs)).toBe("CONTRIBUTING.md");
    expect(selectedPath(undefined, docs)).toBe("docs/new.md");
    expect(selectedPath(undefined, [])).toBeUndefined();
  });
});

describe("changedLines", () => {
  it("reports inserted and replaced head lines", () => {
    const base = "# Title\n\nold para\n\nkeep\n";
    const head = "# Title\n\nnew para\n\nkeep\n\nadded\n";
    expect(changedLines(base, head)).toEqual([
      { start: 3, end: 3, kind: "modified" },
      { start: 6, end: 7, kind: "added" },
    ]);
  });

  it("treats everything as added for a new file and ignores line-ending differences", () => {
    expect(changedLines("", "a\nb")).toEqual([{ start: 1, end: 2, kind: "added" }]);
    expect(changedLines("a\r\nb\r\n", "a\nb\n")).toEqual([]);
  });

  it("marks only the rendered blocks the changes touch", () => {
    const head = "# Title\n\nnew para\n\n- one\n- two\n";
    const rendered = renderMarkdown(head);
    const marks = changeMarks(rendered, changedLines("# Title\n\nold para\n\n- one\n", head));
    const marked = [...marks].map(([id, kind]) => [rendered.nodes[id]!.tagName, rendered.nodes[id]!.text, kind]);
    expect(marked).toEqual([
      ["p", "new para", "modified"],
      ["li", "two", "added"],
    ]);
  });
});

describe("sourceUrl", () => {
  const repo = { host: "github.com", owner: "o", repo: "r" };
  it("links a line of a file at a commit, escaping path segments", () => {
    expect(sourceUrl(repo, "abc", "docs/a b#.md", 12)).toBe("https://github.com/o/r/blob/abc/docs/a%20b%23.md#L12");
    expect(sourceUrl({ ...repo, host: "ghe.example.com" }, "abc", "README.md")).toBe(
      "https://ghe.example.com/o/r/blob/abc/README.md",
    );
  });
});

describe("inAppDocLink", () => {
  const id = { host: "github.com", owner: "o", repo: "r", number: 7 } as PrIdentity;
  it("routes Markdown links to the document in this PR and leaves other files to GitHub", () => {
    expect(inAppDocLink(id, "docs/a b.md", "?x=1#usage")).toBe("/github.com/o/r/pull/7?doc=docs%2Fa+b.md#usage");
    expect(inAppDocLink(id, "README.md", "")).toBe("/github.com/o/r/pull/7?doc=README.md");
    expect(inAppDocLink(id, "src/index.ts", "")).toBeUndefined();
    expect(inAppDocLink(id, "docs/", "")).toBeUndefined();
  });
});
