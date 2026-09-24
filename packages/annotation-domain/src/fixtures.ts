// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderedReviewAnnotationV1 } from "./annotation.js";

/** A valid annotation for tests. */
export function sampleAnnotation(overrides: Partial<RenderedReviewAnnotationV1> = {}): RenderedReviewAnnotationV1 {
  return {
    version: 1,
    target: {
      githubHost: "github.com",
      repositoryId: 123456,
      repository: "acme/widgets",
      pullRequest: 7,
      path: "docs/reliability.md",
      commitOid: "0123456789abcdef0123456789abcdef01234567",
      blobOid: "89abcdef0123456789abcdef0123456789abcdef",
      selectors: [
        {
          type: "TextQuoteSelector",
          exact: "retries failed requests",
          prefix: "The system ",
          suffix: " indefinitely.",
        },
        { type: "TextPositionSelector", start: 11, end: 34 },
        { type: "MarkdownSourceRangeSelector", startLine: 42, startColumn: 12, endLine: 42, endColumn: 35 },
      ],
      structure: { nodeType: "paragraph", headingPath: ["Reliability", "Retries"] },
    },
    motivation: "commenting",
    createdBy: "rendered-review",
    ...overrides,
  };
}
