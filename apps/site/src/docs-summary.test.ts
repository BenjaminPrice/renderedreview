// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { summary } from "./docs-summary";

describe("summary", () => {
  it("takes the first prose paragraph as plain text, skipping headings, code and tables", () => {
    const md =
      "# Title\n\n```sh\nx\n```\n\n| a |\n| - |\n\nRead the `docs` in [GitHub](https://github.com), **now**.\n\nMore.";
    expect(summary(md)).toBe("Read the docs in GitHub, now.");
  });

  it("shortens long paragraphs at a word boundary", () => {
    expect(summary(`# T\n\n${"word ".repeat(50)}`, 20)).toBe("word word word word…");
  });
});
