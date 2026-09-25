// SPDX-License-Identifier: AGPL-3.0-only
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import type { RenderedReviewAnnotationV1 } from "./annotation.js";
import {
  composeCommentBody,
  composeExtendedSuggestionBody,
  composeSuggestionBody,
  permalink,
  repairCommentBody,
  stripRedundantContext,
} from "./body.js";
import { encodeAnnotation, extractAnnotation } from "./envelope.js";
import { sampleAnnotation } from "./fixtures.js";

const annotation = sampleAnnotation();
const marker = encodeAnnotation(annotation);
const comment = "Should this define a retry limit and backoff policy?";
const link =
  "Document: [`docs/reliability.md`](https://github.com/acme/widgets/blob/0123456789abcdef0123456789abcdef01234567/docs/reliability.md?plain=1#L42-L42)";

function withTarget(target: Partial<RenderedReviewAnnotationV1["target"]>, exact?: string) {
  const a = sampleAnnotation();
  Object.assign(a.target, target);
  if (exact !== undefined) a.target.selectors[0] = { type: "TextQuoteSelector", exact };
  return a;
}

describe("composeCommentBody", () => {
  it("builds a native review comment: quote, comment, marker", () => {
    expect(composeCommentBody({ annotation, comment, location: "review-line" })).toBe(
      `> retries failed requests\n\n${comment}\n\n${marker}`,
    );
  });

  it("builds a file-level review comment: quote, comment, permalink, marker", () => {
    expect(composeCommentBody({ annotation, comment, location: "review-file" })).toBe(
      `> retries failed requests\n\n${comment}\n\n${link}\n\n${marker}`,
    );
  });

  it("builds a conversation comment: quote, comment, permalink, marker", () => {
    expect(composeCommentBody({ annotation, comment, location: "conversation" })).toBe(
      `> retries failed requests\n\n${comment}\n\n${link}\n\n${marker}`,
    );
  });

  it("carries the annotation so it can be extracted again", () => {
    const body = composeCommentBody({ annotation, comment, location: "conversation" });
    expect(extractAnnotation(body)).toMatchObject({ status: "ok", annotation });
  });

  it("omits an empty comment", () => {
    expect(composeCommentBody({ annotation, comment: "  \n", location: "review-line" })).toBe(
      `> retries failed requests\n\n${marker}`,
    );
  });

  // The blockquote must render as exactly the selected text, whatever Markdown it looks like.
  it.each([
    ["headings", "# Not a heading"],
    ["list markers", "- not a list\n+ nor this\n* nor this\n1. nor this"],
    ["nested quotes", "> not nested"],
    ["code spans and fences", "`code` and\n```\nfence"],
    ["HTML", "<b>bold</b> <!-- comment --> <script>x</script>"],
    ["tables", "| a | b |\n| - | - |"],
    ["emphasis and links", "*em* _em_ **strong** ~~del~~ [link](https://x.test) ![img](x.png)"],
    ["backslashes and entities", "C:\\path\\ &amp; &#42; \\*"],
    ["setext underlines and rules", "Title\n===\nOther\n---\n***"],
    // Renderers drop spaces next to line breaks, so rendered selections never contain them.
    ["leading and trailing whitespace", "    indented\tand tabbed  "],
    ["a leading tab", "\tTabbed"],
    ["autolinks", "https://example.com and www.example.com"],
    ["multiple lines", "first line\nsecond line"],
    ["multiple paragraphs", "first paragraph\n\nsecond paragraph"],
    ["non-ASCII", "Déjà vu — 重试 🚢"],
  ])("quotes %s faithfully", (_name, exact) => {
    const body = composeCommentBody({ annotation: withTarget({}, exact), comment: "", location: "review-line" });
    const { nodes } = renderMarkdown(body);
    expect(nodes[0]?.type).toBe("blockquote");
    const paragraphs = nodes.filter((n) => n.type === "paragraph" && n.parentId === 0);
    expect(nodes.filter((n) => n.parentId === 0).every((n) => n.type === "paragraph")).toBe(true);
    expect(paragraphs.map((p) => p.text).join("\n\n")).toBe(exact);
  });
});

describe("permalink", () => {
  it("links the immutable blob at the source lines", () => {
    expect(permalink(annotation)).toBe(
      "https://github.com/acme/widgets/blob/0123456789abcdef0123456789abcdef01234567/docs/reliability.md?plain=1#L42-L42",
    );
  });

  it("encodes each path segment and supports other hosts", () => {
    const a = withTarget({ githubHost: "github.example.com", path: "docs/Design (v2)/ä #1?.md" });
    expect(permalink(a)).toBe(
      "https://github.example.com/acme/widgets/blob/0123456789abcdef0123456789abcdef01234567/docs/Design%20%28v2%29/%C3%A4%20%231%3F.md?plain=1#L42-L42",
    );
  });

  it("does not include a line the range only touches at column 1", () => {
    const a = sampleAnnotation();
    a.target.selectors[2] = {
      type: "MarkdownSourceRangeSelector",
      startLine: 3,
      startColumn: 1,
      endLine: 6,
      endColumn: 1,
    };
    expect(permalink(a)).toMatch(/#L3-L5$/);
  });

  it("shows a path containing backticks as a code span", () => {
    const body = composeCommentBody({ annotation: withTarget({ path: "a`b.md" }), comment, location: "conversation" });
    expect(body).toContain("Document: [``a`b.md``](");
  });
});

describe("composeSuggestionBody", () => {
  const suggesting = sampleAnnotation({ motivation: "suggesting" });
  const suggestingMarker = encodeAnnotation(suggesting);

  it("builds a native GitHub suggestion with the marker", () => {
    expect(
      composeSuggestionBody({ annotation: suggesting, comment: "Cap it.", replacement: "Retries up to 5 times." }),
    ).toBe(`Cap it.\n\n\`\`\`suggestion\nRetries up to 5 times.\n\`\`\`\n\n${suggestingMarker}`);
  });

  it("uses a longer fence when the replacement contains backticks, and allows deletion", () => {
    expect(composeSuggestionBody({ annotation: suggesting, comment: "", replacement: "```js\nx\n```" })).toBe(
      `\`\`\`\`suggestion\n\`\`\`js\nx\n\`\`\`\n\`\`\`\`\n\n${suggestingMarker}`,
    );
    expect(composeSuggestionBody({ annotation: suggesting, comment: "", replacement: "" })).toBe(
      `\`\`\`suggestion\n\`\`\`\n\n${suggestingMarker}`,
    );
  });

  it("requires the suggesting motivation", () => {
    expect(() => composeSuggestionBody({ annotation, comment: "", replacement: "x" })).toThrow(TypeError);
  });
});

describe("composeExtendedSuggestionBody", () => {
  const suggesting = sampleAnnotation({ motivation: "suggesting" });
  const suggestingMarker = encodeAnnotation(suggesting);

  it("builds a quote, comment, manual-apply note, diff, permalink and marker", () => {
    expect(
      composeExtendedSuggestionBody({
        annotation: suggesting,
        comment: "Cap it.",
        original: "The system retries failed requests\nindefinitely.",
        replacement: "The system retries failed requests\nup to 5 times.",
      }),
    ).toBe(
      [
        "> retries failed requests",
        "Cap it.",
        "**Suggested change** (apply it manually; GitHub cannot apply suggestions outside the pull request diff):",
        "```diff\n-The system retries failed requests\n-indefinitely.\n+The system retries failed requests\n+up to 5 times.\n```",
        link,
        suggestingMarker,
      ].join("\n\n"),
    );
  });

  it("requires the suggesting motivation", () => {
    expect(() => composeExtendedSuggestionBody({ annotation, comment: "", original: "a", replacement: "b" })).toThrow(
      TypeError,
    );
  });
});

describe("stripRedundantContext", () => {
  const body = composeCommentBody({ annotation, comment, location: "conversation" });

  it("hides the quote and permalink when the metadata validated and the quote matches", () => {
    expect(stripRedundantContext(body, annotation, true)).toBe(`${comment}\n\n${marker}`);
  });

  it("also works on bodies GitHub returns with CRLF line endings", () => {
    expect(stripRedundantContext(body.replace(/\n/g, "\r\n"), annotation, true)).toBe(`${comment}\n\n${marker}`);
  });

  it("shows the full body when the metadata did not validate", () => {
    expect(stripRedundantContext(body, annotation, false)).toBe(body);
  });

  it("shows the full body when the quote was edited on GitHub", () => {
    const edited = body.replace("> retries failed requests", "> retries failed requests forever");
    expect(stripRedundantContext(edited, annotation, true)).toBe(edited);
  });

  it("keeps an edited permalink line while hiding a matching quote", () => {
    const edited = body.replace("#L42-L42", "#L40-L42");
    expect(stripRedundantContext(edited, annotation, true)).toBe(
      `${comment}\n\n${link.replace("#L42", "#L40")}\n\n${marker}`,
    );
  });
});

describe("repairCommentBody", () => {
  const moved = withTarget(
    {
      commitOid: "fedcba9876543210fedcba9876543210fedcba98",
      selectors: [
        { type: "TextQuoteSelector", exact: "backs off" },
        { type: "TextPositionSelector", start: 100, end: 109 },
        { type: "MarkdownSourceRangeSelector", startLine: 50, startColumn: 3, endLine: 50, endColumn: 12 },
      ],
    },
    "backs off",
  );
  const newLink = link.replace(/blob\/\w+/, `blob/${moved.target.commitOid}`).replace("#L42-L42", "#L50-L50");
  // Prose GitHub users write: CRLF line endings, trailing spaces, Markdown that must not be touched.
  const prose = "Should this *define* a limit?  \r\n\r\n- one\r\n- two\r\n\r\n> quoted later";

  it("replaces the quote, permalink and marker and keeps the comment byte for byte", () => {
    const body = composeCommentBody({ annotation, comment: prose, location: "conversation" });
    const repaired = repairCommentBody({ body, annotation: moved, location: "conversation" });
    expect(repaired.body).toBe(`> backs off\n\n${prose}\n\n${newLink}\n\n${encodeAnnotation(moved)}`);
    expect(repaired.comment).toBe(prose);
    expect(repaired.removed).toEqual({ quote: "> retries failed requests", permalink: link, marker });
    expect(repaired.added).toEqual({ quote: "> backs off", permalink: newLink, marker: encodeAnnotation(moved) });
  });

  it("writes a marker that validates to the new annotation", () => {
    const body = composeCommentBody({ annotation, comment, location: "review-line" });
    const repaired = repairCommentBody({ body, annotation: moved, location: "review-line" });
    expect(extractAnnotation(repaired.body)).toMatchObject({ status: "ok", annotation: moved });
    expect(repaired.body).toBe(`> backs off\n\n${comment}\n\n${encodeAnnotation(moved)}`);
  });

  it("repairs a damaged marker and a GitHub CRLF body", () => {
    const body = `> retries failed requests\r\n\r\n${comment}\r\n\r\n<!-- rendered-review:v1:not base64! -->`;
    const repaired = repairCommentBody({ body, annotation: moved, location: "review-line" });
    expect(repaired.comment).toBe(comment);
    expect(repaired.removed).toEqual({
      quote: "> retries failed requests",
      marker: "<!-- rendered-review:v1:not base64! -->",
    });
    expect(extractAnnotation(repaired.body).status).toBe("ok");
  });

  it("replaces an unsupported version's marker and an unclosed one up to its line end", () => {
    const v2 = repairCommentBody({
      body: `> old\n\n${comment}\n\n<!-- rendered-review:v2:e30= -->`,
      annotation: moved,
      location: "review-line",
    });
    expect(v2.comment).toBe(comment);
    const unclosed = repairCommentBody({
      body: `${comment}\n\n<!-- rendered-review:v1:abc\nafter`,
      annotation: moved,
      location: "review-line",
    });
    expect(unclosed.comment).toBe(comment);
    expect(unclosed.body).toBe(`> backs off\n\n${comment}\n\n${encodeAnnotation(moved)}\n\nafter`);
  });

  it("adds a quote to a body without one, such as a native suggestion", () => {
    const body = `Use this:\n\n\`\`\`suggestion\nnew\n\`\`\`\n\n${marker}`;
    const repaired = repairCommentBody({ body, annotation: moved, location: "review-line" });
    expect(repaired.comment).toBe("Use this:\n\n```suggestion\nnew\n```");
    expect(repaired.removed).toEqual({ marker });
    expect(repaired.body).toBe(`> backs off\n\n${repaired.comment}\n\n${encodeAnnotation(moved)}`);
  });
});
