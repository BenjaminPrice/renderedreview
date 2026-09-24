// SPDX-License-Identifier: AGPL-3.0-only
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import mdn from "./fixtures/blob-1a05f7e9c35e2bb310563708351758307f34a599.md?raw";
import { renderJob } from "./render-job";

const pr = { host: "github.com", owner: "o", repo: "r", number: 7 };

describe("renderJob", () => {
  it("renders with the document's location and in-app links, as plain data a Worker can post", () => {
    const source = "See [the guide](guide.md) and ![logo](img/logo.png).\n";
    const result = renderJob({ source, pr, sha: "abc", path: "docs/a.md" });
    expect(result).toEqual(structuredClone(result));
    const html = JSON.stringify(result);
    expect(html).toContain("/github.com/o/r/pull/7?doc=docs%2Fguide.md");
    expect(html).toContain("https://raw.githubusercontent.com/o/r/abc/docs/img/logo.png");
  });

  it("renders a real document to the same tree as renderMarkdown", () => {
    const result = renderJob({ source: mdn, pr, sha: "abc", path: "status.md" });
    expect(structuredClone(result)).toEqual(result);
    expect(result).toMatchObject({ nodes: renderMarkdown(mdn).nodes.map(({ id, type }) => ({ id, type })) });
  });

  it("parses .mdx as MDX, throwing its parse error", () => {
    expect(() => renderJob({ source: "<Tabs>\n", pr, sha: "abc", path: "a.mdx" })).toThrow(/Invalid MDX/);
  });
});
