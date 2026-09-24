// SPDX-License-Identifier: AGPL-3.0-only
import { composeCommentBody, type RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import { describe, expect, it } from "vitest";
import { classifyComment } from "./classify.js";
import { annotation, at, context, issueComment, reviewComment, target } from "./fixtures.js";

const body = (a: RenderedReviewAnnotationV1 = annotation(), comment = "Should this define a retry limit?") =>
  composeCommentBody({ annotation: a, comment, location: "conversation" });

const created = at(0);
const edited = { createdAt: created, updatedAt: at(600) };

describe("classifyComment: design state table", () => {
  it("native comment: no application marker", () => {
    expect(classifyComment(issueComment("Plain GitHub comment."), context)).toEqual({ state: "native", edited: false });
  });

  it("valid annotation: decodes, validates and matches the pull request", () => {
    const a = annotation();
    expect(classifyComment(issueComment(body(a)), context)).toEqual({ state: "valid", annotation: a, edited: false });
  });

  it("edited prose: GitHub reports an edit, the annotation stays consistent", () => {
    const a = annotation();
    const c = issueComment(body(a, "Reworded after the fact."), edited);
    expect(classifyComment(c, context)).toEqual({ state: "edited-prose", annotation: a, edited: true });
  });

  it("edited visible quote: the quote no longer corresponds to the annotation", () => {
    const a = annotation();
    const c = issueComment(body(a).replace("> retries failed requests", "> retries some requests"), edited);
    expect(classifyComment(c, context)).toMatchObject({ state: "edited-quote", annotation: a, edited: true });
  });

  it("missing metadata: the marker was removed from an application comment", () => {
    const c = issueComment(body().replace(/\n\n<!-- rendered-review:v1:[^>]+>$/, ""), edited);
    expect(classifyComment(c, context)).toEqual({ state: "missing", edited: true });
  });

  it("damaged metadata: the envelope does not decode", () => {
    const c = issueComment("Hi\n\n<!-- rendered-review:v1:%%% -->");
    expect(classifyComment(c, context)).toMatchObject({ state: "damaged", edited: false, reason: expect.any(String) });
  });

  it("unsupported version: the marker version is unknown", () => {
    const c = issueComment("Hi\n\n<!-- rendered-review:v2:e30= -->");
    expect(classifyComment(c, context)).toMatchObject({ state: "unsupported", reason: expect.stringContaining("2") });
  });

  it("GitHub's creation bump alone is not an edit", () => {
    const c = issueComment(body(), { createdAt: created, updatedAt: at(2) });
    expect(classifyComment(c, context).state).toBe("valid");
  });
});

describe("classifyComment: references to another pull request are damaged", () => {
  it.each<[string, RenderedReviewAnnotationV1]>([
    ["another pull request", target({ pullRequest: 8 })],
    ["another repository id", target({ repositoryId: 43 })],
    ["another repository id with the same name", target({ repositoryId: 43, repository: "acme/docs" })],
    ["another host", target({ githubHost: "github.example.com" })],
  ])("%s", (_name, a) => {
    const result = classifyComment(issueComment(body(a)), context);
    expect(result).toMatchObject({ state: "damaged", reason: expect.any(String) });
    expect(result.annotation).toBeUndefined();
  });

  it("accepts a renamed or transferred repository: the id is its identity, the name is only for reading", () => {
    const a = target({ repository: "old-owner/old-name" });
    expect(classifyComment(issueComment(body(a)), context)).toMatchObject({ state: "valid", annotation: a });
  });

  it("compares host and repository name case-insensitively", () => {
    const a = target({ githubHost: "GitHub.com", repository: "Acme/Docs" });
    expect(classifyComment(issueComment(body(a)), context).state).toBe("valid");
  });

  it("a review comment whose annotation names another file", () => {
    const c = reviewComment(body(target({ path: "other.md" })));
    expect(classifyComment(c, context)).toMatchObject({ state: "damaged" });
  });

  it("path traversal in the annotation", () => {
    // Encoded by hand: the encoder refuses invalid annotations.
    const json = JSON.stringify(target({ path: "docs/../../etc/passwd.md" }));
    const c = issueComment(`> x\n\n<!-- rendered-review:v1:${btoa(json)} -->`);
    expect(classifyComment(c, context)).toMatchObject({ state: "damaged", reason: expect.stringContaining("path") });
  });
});
