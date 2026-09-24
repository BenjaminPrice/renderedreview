// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { isMarkdownPath, parsePrParams, parsePullRequestUrl, validatePrSearch as validate } from "./pr-url";

// Raw search objects as the router hands them over (untyped, unbranded).
const validatePrSearch = (search: Record<string, unknown>) => validate(search as Parameters<typeof validate>[0]);

const pr = { host: "github.com", owner: "acme", repo: "widgets", number: 123 };

describe("parsePullRequestUrl", () => {
  it.each([
    "https://github.com/acme/widgets/pull/123",
    "https://github.com/acme/widgets/pull/123/files",
    "https://github.com/acme/widgets/pull/123/commits/abc?diff=split#r1",
    "  github.com/acme/widgets/pull/123  ",
    "https://www.github.com/acme/widgets/pull/123",
  ])("parses %s", (url) => expect(parsePullRequestUrl(url)).toEqual(pr));

  it("parses GitHub Enterprise Server URLs", () => {
    expect(parsePullRequestUrl("https://GHE.example.com/my_org/docs.site/pull/7/files")).toEqual({
      host: "ghe.example.com",
      owner: "my_org",
      repo: "docs.site",
      number: 7,
    });
  });

  it.each([
    "",
    "not a url",
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets/issues/123",
    "https://github.com/acme/widgets/pull/abc",
    "https://github.com/acme/widgets/pull/0",
    "ftp://github.com/acme/widgets/pull/1",
    "https://localhost/acme/widgets/pull/1",
  ])("rejects %j", (url) => expect(parsePullRequestUrl(url)).toBeUndefined());
});

describe("parsePrParams", () => {
  const raw = { host: "github.com", owner: "acme", repo: "widgets", number: "123" };

  it("accepts a valid deep link", () => expect(parsePrParams(raw)).toEqual(pr));
  it.each(["ghe.example.com:1", "ghe.example.com:8443", "ghe.example.com:65535"])("accepts port in %s", (host) =>
    expect(parsePrParams({ ...raw, host })?.host).toBe(host),
  );
  it("lowercases the host", () => expect(parsePrParams({ ...raw, host: "GitHub.com" })?.host).toBe("github.com"));
  it.each([
    { host: "github" },
    { host: "git hub.com" },
    { host: "ghe.example.com:0" },
    { host: "ghe.example.com:65536" },
    { host: "ghe.example.com:99999" },
    { host: "ghe.example.com:0443" },
    { host: "ghe.example.com:" },
    { host: "ghe.example.com:1:2" },
    { owner: ".." },
    { repo: "." },
    { repo: "a/b" },
    { number: "01" },
    { number: "1.5" },
    { number: "-1" },
    { number: "99999999999" },
  ])("rejects %j", (bad) => expect(parsePrParams({ ...raw, ...bad })).toBeUndefined());
});

describe("validatePrSearch", () => {
  it("defaults files to changed", () => expect(validatePrSearch({})).toEqual({ files: "changed" }));
  it("keeps valid state", () =>
    expect(validatePrSearch({ files: "all", doc: "docs/a.md", thread: "PRRT_x" })).toEqual({
      files: "all",
      doc: "docs/a.md",
      thread: "PRRT_x",
    }));
  it("keeps numeric thread ids", () => expect(validatePrSearch({ thread: 42 }).thread).toBe(42));
  it("drops invalid values", () =>
    expect(validatePrSearch({ files: "bogus", doc: 5, thread: "" })).toEqual({ files: "changed" }));
});

it("detects Markdown paths", () => {
  expect(["a.md", "docs/B.MARKDOWN", "a.mdx", "md", "a.md.txt"].map(isMarkdownPath)).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
});
