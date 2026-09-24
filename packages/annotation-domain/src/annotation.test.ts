// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { validateAnnotation } from "./annotation.js";
import { sampleAnnotation } from "./fixtures.js";

// Invalid-shape tests poke at arbitrary JSON, so the mutation callback is untyped on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Deep-clone the sample as plain JSON and apply a mutation, for invalid-shape tests. */
function mutated(mutate: (a: Json) => void): unknown {
  const a = JSON.parse(JSON.stringify(sampleAnnotation()));
  mutate(a);
  return a;
}

describe("validateAnnotation", () => {
  it("accepts a complete v1 annotation", () => {
    expect(validateAnnotation(sampleAnnotation())).toEqual({ ok: true, annotation: sampleAnnotation() });
  });

  it("accepts the minimal annotation (optional fields absent, selectors in any order)", () => {
    const a = mutated((a) => {
      delete a.target.structure;
      delete a.createdBy;
      delete a.target.selectors[0].prefix;
      delete a.target.selectors[0].suffix;
      a.target.selectors.reverse();
    });
    expect(validateAnnotation(a).ok).toBe(true);
  });

  it("ignores unknown fields and unknown selector types for forward compatibility", () => {
    const a = mutated((a) => {
      a.futureField = { anything: true };
      a.target.futureTargetField = 1;
      a.target.selectors.push({ type: "FutureSelector", value: 1 });
    });
    expect(validateAnnotation(a).ok).toBe(true);
  });

  it.each<[string, (a: Json) => void]>([
    ["not an object", (a) => Object.keys(a).forEach((k) => delete a[k])],
    ["version 2", (a) => (a.version = 2)],
    ["missing target", (a) => delete a.target],
    ["host with a scheme", (a) => (a.target.githubHost = "https://github.com")],
    ["host with a path", (a) => (a.target.githubHost = "github.com/evil")],
    ["repository id as string", (a) => (a.target.repositoryId = "123456")],
    ["repository id not an integer", (a) => (a.target.repositoryId = 1.5)],
    ["repository without owner", (a) => (a.target.repository = "widgets")],
    ["pull request zero", (a) => (a.target.pullRequest = 0)],
    ["empty path", (a) => (a.target.path = "")],
    ["absolute path", (a) => (a.target.path = "/etc/passwd")],
    ["path with a .. segment", (a) => (a.target.path = "docs/../../secrets.md")],
    ["path that is ..", (a) => (a.target.path = "..")],
    ["path with a . segment", (a) => (a.target.path = "docs/./guide.md")],
    ["path with an empty segment", (a) => (a.target.path = "docs//guide.md")],
    ["path with a trailing slash", (a) => (a.target.path = "docs/")],
    ["path with a backslash", (a) => (a.target.path = "docs\\..\\guide.md")],
    ["path with a control character", (a) => (a.target.path = "docs/gu\nide.md")],
    ["short commit oid", (a) => (a.target.commitOid = "0123456")],
    ["uppercase blob oid", (a) => (a.target.blobOid = a.target.blobOid.toUpperCase())],
    ["selectors not an array", (a) => (a.target.selectors = {})],
    ["missing quote selector", (a) => a.target.selectors.splice(0, 1)],
    ["missing position selector", (a) => a.target.selectors.splice(1, 1)],
    ["missing source range selector", (a) => a.target.selectors.splice(2, 1)],
    ["duplicate quote selector", (a) => a.target.selectors.push({ ...a.target.selectors[0] })],
    ["empty exact", (a) => (a.target.selectors[0].exact = "")],
    ["prefix over 64 characters", (a) => (a.target.selectors[0].prefix = "x".repeat(65))],
    ["suffix over 64 characters", (a) => (a.target.selectors[0].suffix = "x".repeat(65))],
    ["position end before start", (a) => (a.target.selectors[1].end = 3)],
    ["negative position", (a) => (a.target.selectors[1].start = -1)],
    ["line zero", (a) => (a.target.selectors[2].startLine = 0)],
    ["source range end before start", (a) => (a.target.selectors[2].endLine = 41)],
    ["same-line range ending before it starts", (a) => (a.target.selectors[2].endColumn = 11)],
    ["headingPath with a number", (a) => (a.target.structure.headingPath = ["ok", 1])],
    ["unknown motivation", (a) => (a.motivation = "liking")],
    ["replyTo not a string", (a) => (a.replyTo = 5)],
    ["other createdBy", (a) => (a.createdBy = "someone-else")],
    ["unknown resolution", (a) => (a.resolution = "closed")],
  ])("rejects %s", (_name, mutate) => {
    const result = validateAnnotation(mutated(mutate));
    expect(result.ok).toBe(false);
  });

  it("accepts nested paths and dots inside names", () => {
    for (const path of ["README.md", "docs/.github/a..b.md", "docs/v1.2/guide.md"])
      expect(validateAnnotation(mutated((a) => (a.target.path = path))).ok).toBe(true);
  });

  it("accepts a resolution event that reopens a thread", () => {
    const a = mutated((a) => {
      a.motivation = "resolving";
      a.threadId = "101";
      a.resolution = "reopened";
    });
    expect(validateAnnotation(a).ok).toBe(true);
  });

  it("names the offending field", () => {
    expect(validateAnnotation(mutated((a) => (a.target.pullRequest = "7")))).toEqual({
      ok: false,
      reason: "target.pullRequest must be a positive integer",
    });
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, 1, "x", [], true]) expect(validateAnnotation(value).ok).toBe(false);
  });
});
