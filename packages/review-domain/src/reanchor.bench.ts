// SPDX-License-Identifier: AGPL-3.0-only
// Timing lives here, not in the unit suite: run with `pnpm bench`.
import type { RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import { documentText, renderMarkdown } from "@rendered-review/markdown-domain";
import { test } from "vitest";
import { reanchor } from "./reanchor.js";

const para = (i: number) => `Paragraph ${i} talks about topic ${i % 97} in some detail.\n\n`;
const before = Array.from({ length: 4000 }, (_, i) => (i % 400 === 0 ? `# Part ${i}\n\n` : para(i))).join("");
const after = "Preface.\n\n" + before.replace("Paragraph 3210 talks", "Paragraph 3210 speaks");
const doc = renderMarkdown(after);

const text = documentText(renderMarkdown(before), before);

/** The annotation a reader would create by selecting the first `quote` in `before`. */
function annotate(quote: string): RenderedReviewAnnotationV1 {
  const t = text;
  const at = t.text.indexOf(quote);
  const r = t.select(at, at + quote.length);
  if (!r.ok) throw new Error(r.message);
  const { exact, prefix, suffix, textPosition, sourceRange, nodeType, headingPath } = r.selection;
  return {
    version: 1,
    target: {
      githubHost: "github.com",
      repositoryId: 1,
      repository: "acme/docs",
      pullRequest: 1,
      path: "doc.md",
      commitOid: "c".repeat(40),
      blobOid: "a",
      selectors: [
        { type: "TextQuoteSelector", exact, prefix, suffix },
        { type: "TextPositionSelector", ...textPosition },
        { type: "MarkdownSourceRangeSelector", ...sourceRange },
      ],
      structure: { nodeType, headingPath },
    },
    motivation: "commenting",
  };
}

// A distinct original blob per run defeats reanchor's memo, so every run does the work.
let run = 0;
const measure = (annotation: RenderedReviewAnnotationV1) => () => {
  const target = { ...annotation.target, blobOid: `a${run++}` };
  reanchor({ annotation: { ...annotation, target }, blobOid: "b", source: after, doc });
};

test("re-anchoring in a 4000-paragraph document", async ({ bench }) => {
  await bench.compare(
    bench("exact path", measure(annotate("topic 9 in"))),
    bench("fuzzy path", measure(annotate("Paragraph 3210 talks about"))),
  );
});
