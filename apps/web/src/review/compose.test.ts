// SPDX-License-Identifier: AGPL-3.0-only
import { extractAnnotation } from "@rendered-review/annotation-domain";
import type { ChangedFile } from "@rendered-review/github-integration";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import { commentIntent, composeDraftBody, prepareAnnotation, representationFor, type CommentTarget } from "./compose";

const HEAD = "a".repeat(40);
const BLOB = "b".repeat(40);
const target: CommentTarget = {
  host: "github.com",
  repositoryId: 42,
  repository: "acme/widgets",
  pullRequest: 7,
  path: "docs/retry.md",
  commitOid: HEAD,
  blobOid: BLOB,
};
const selection: SourceSelection = {
  exact: "full jitter",
  prefix: "Each delay includes ",
  suffix: " of up to 20%",
  textPosition: { start: 120, end: 131 },
  sourceRange: { startLine: 24, startColumn: 21, endLine: 24, endColumn: 32 },
  nodeType: "paragraph",
  headingPath: ["Retries", "Schedule"],
  blockIds: [9],
  expanded: false,
};
const file = (patch: string): ChangedFile => ({
  path: "docs/retry.md",
  status: "modified",
  blobOid: BLOB,
  additions: 1,
  deletions: 1,
  changes: 2,
  patch,
});

describe("prepareAnnotation", () => {
  it("targets the PR document with quote, position and source range selectors", () => {
    const result = prepareAnnotation(target, selection);
    expect(result).toEqual({
      ok: true,
      annotation: {
        version: 1,
        target: {
          githubHost: "github.com",
          repositoryId: 42,
          repository: "acme/widgets",
          pullRequest: 7,
          path: "docs/retry.md",
          commitOid: HEAD,
          blobOid: BLOB,
          selectors: [
            {
              type: "TextQuoteSelector",
              exact: "full jitter",
              prefix: "Each delay includes ",
              suffix: " of up to 20%",
            },
            { type: "TextPositionSelector", start: 120, end: 131 },
            { type: "MarkdownSourceRangeSelector", startLine: 24, startColumn: 21, endLine: 24, endColumn: 32 },
          ],
          structure: { nodeType: "paragraph", headingPath: ["Retries", "Schedule"] },
        },
        motivation: "commenting",
        createdBy: "rendered-review",
      },
    });
  });

  it("asks for a narrower selection when the quote is too long to encode", () => {
    const result = prepareAnnotation(target, { ...selection, exact: "word ".repeat(4000) });
    expect(result).toEqual({
      ok: false,
      message: "This selection is too long to comment on. Select a shorter passage.",
    });
  });
});

describe("representationFor", () => {
  it("is a native line comment when the lines are in the diff", () => {
    const rep = representationFor([file("@@ -20,6 +20,6 @@\n a\n b\n c\n-d\n+D\n e\n f")], "docs/retry.md", selection);
    expect(rep).toMatchObject({ kind: "review-line", line: 24, side: "RIGHT" });
    expect(rep.reason).toBe("Will post as native review comment · line 24 is in this PR's diff");
  });

  it("is a conversation comment for a document the PR does not change", () => {
    expect(representationFor([], "docs/retry.md", selection).kind).toBe("conversation");
  });

  it("does not count a line the range only reaches at its first column", () => {
    const multi = { ...selection, sourceRange: { startLine: 23, startColumn: 1, endLine: 25, endColumn: 1 } };
    const rep = representationFor([file("@@ -20,5 +20,5 @@\n a\n b\n c\n-d\n+D\n e")], "docs/retry.md", multi);
    expect(rep).toMatchObject({ kind: "review-line", startLine: 23, line: 24 });
  });
});

describe("composeDraftBody", () => {
  it("writes a readable body whose marker decodes to the annotation", () => {
    const prepared = prepareAnnotation(target, selection);
    if (!prepared.ok) throw new Error(prepared.message);
    const body = composeDraftBody(prepared.annotation, "Which jitter?", { kind: "conversation", reason: "" });
    expect(body).toMatch(/^> full jitter\n\nWhich jitter\?\n\n/);
    expect(body).toContain("Document: [`docs/retry.md`]");
    const decoded = extractAnnotation(body);
    expect(decoded.status).toBe("ok");
    expect(decoded.status === "ok" && decoded.annotation).toEqual(prepared.annotation);
  });
});

describe("commentIntent", () => {
  it("carries the GitHub location fields for each representation", () => {
    const base = { body: "b", path: "docs/retry.md" };
    expect(
      commentIntent(
        {
          ...base,
          representation: {
            kind: "review-line",
            line: 25,
            side: "RIGHT",
            startLine: 23,
            startSide: "RIGHT",
            reason: "",
          },
        },
        HEAD,
      ),
    ).toEqual({
      body: "b",
      expectedHeadOid: HEAD,
      representation: "review-line",
      path: "docs/retry.md",
      line: 25,
      side: "RIGHT",
      startLine: 23,
      startSide: "RIGHT",
    });
    expect(commentIntent({ ...base, representation: { kind: "review-file", reason: "" } }, HEAD)).toEqual({
      body: "b",
      expectedHeadOid: HEAD,
      representation: "review-file",
      path: "docs/retry.md",
    });
    expect(commentIntent({ ...base, representation: { kind: "conversation", reason: "" } }, HEAD)).toEqual({
      body: "b",
      expectedHeadOid: HEAD,
      representation: "conversation",
    });
  });
});
