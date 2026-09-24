// SPDX-License-Identifier: AGPL-3.0-only
// Main-thread cost of the document pipeline over a representative corpus. Run with
// `pnpm bench`. Numbers pick `WORKER_THRESHOLD_CHARS`.
import type { RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import { blocksForLines, documentText, renderMarkdown } from "@rendered-review/markdown-domain";
import { reanchor } from "@rendered-review/review-domain";
import { test } from "vitest";
import { changedLines } from "./docs";
import mdn from "./fixtures/blob-1a05f7e9c35e2bb310563708351758307f34a599.md?raw";
import mdnBase from "./fixtures/blob-4e1326aa2512d4d8eec8533471eee0dc684de810.md?raw";

const repeat = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");

/** A generated-docs page: `rows`-row tables. */
const table = (rows: number) =>
  "| Name | Type | Default | Description |\n|---|---|---|---|\n" +
  repeat(rows, (i) => `| \`option${i}\` | \`string\` | \`"v${i}"\` | Sets option **${i}**, see [docs](#o${i}). |\n`);

/** Code-heavy: prose between fenced blocks. */
const code = (blocks: number) =>
  repeat(
    blocks,
    (i) =>
      `## Step ${i}\n\nRun the following:\n\n\`\`\`ts\nexport function step${i}(input: string): number {\n  const parts = input.split(",");\n  return parts.length * ${i};\n}\n\`\`\`\n\n`,
  );

/** Large generated Markdown: the MDN status-code page repeated to `chars`. */
const generated = (chars: number) => mdn.repeat(Math.ceil(chars / mdn.length)).slice(0, chars);

export const corpus: Record<string, string> = {
  "typical (17 KB)": mdn,
  "table 2k rows (190 KB)": table(2000),
  "code 1k fences (190 KB)": code(1000),
  "generated 100 KB": generated(100_000),
  "generated 250 KB": generated(250_000),
  "generated 500 KB": generated(500_000),
  "generated 1 MB": generated(1_000_000),
};

// Few, cold-ish runs: first-render cost is what a reader waits for.
const opts = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 };

test("renderMarkdown", async ({ bench }) => {
  await bench.compare(
    ...Object.entries(corpus).map(([name, source]) => bench(name, () => void renderMarkdown(source))),
    opts,
  );
});

test("changedLines (base vs head, every 50th line edited)", async ({ bench }) => {
  const runs = Object.entries(corpus).map(([name, source]) => {
    const base = source
      .split("\n")
      .map((l, i) => (i % 50 === 0 ? `${l} (old)` : l))
      .join("\n");
    return bench(name, () => void changedLines(base, source));
  });
  await bench.compare(
    ...runs,
    bench("typical, real revision", () => void changedLines(mdnBase, mdn)),
    opts,
  );
});

test("re-anchoring 500 comments after an edit", async ({ bench }) => {
  const runs = [];
  const sizes = { "typical (17 KB)": mdn, "generated 250 KB": generated(250_000) };
  for (const [name, source] of Object.entries(sizes)) {
    const doc = renderMarkdown(source);
    const text = documentText(doc, source);
    // 500 selections of 3–4 words spread through the document, as readers would make them.
    const annotations: RenderedReviewAnnotationV1[] = [];
    for (let i = 0; annotations.length < 500 && i < 5000; i++) {
      const at = text.text.indexOf(" ", Math.floor((text.text.length * i) / 5000)) + 1;
      const r = text.select(at, Math.min(at + 24, text.text.length));
      if (!r.ok) continue;
      const { exact, prefix, suffix, textPosition, sourceRange } = r.selection;
      annotations.push({
        version: 1,
        motivation: "commenting",
        target: {
          githubHost: "github.com",
          repositoryId: 1,
          repository: "o/r",
          pullRequest: 1,
          path: "doc.md",
          commitOid: "c".repeat(40),
          blobOid: "a".repeat(40),
          selectors: [
            { type: "TextQuoteSelector", exact, prefix, suffix },
            { type: "TextPositionSelector", ...textPosition },
            { type: "MarkdownSourceRangeSelector", ...sourceRange },
          ],
        },
      });
    }
    // The document gained a paragraph at the top, so every comment must be searched for.
    const edited = `Intro paragraph added.\n\n${source}`;
    const editedDoc = renderMarkdown(edited);
    let run = 0;
    runs.push(
      bench(`${name}, ${annotations.length} comments`, () => {
        // A fresh blob id per run defeats reanchor's memo, so each run searches.
        const blobOid = String(++run).padStart(40, "0");
        for (const annotation of annotations) reanchor({ annotation, blobOid, source: edited, doc: editedDoc });
      }),
      bench(`${name}, blocksForLines x500`, () => {
        for (let i = 0; i < 500; i++) blocksForLines(doc, i * 2 + 1, i * 2 + 3);
      }),
    );
  }
  await bench.compare(...runs, opts);
});
