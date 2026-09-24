# Rendered Review annotation format, version 1

Rendered Review publishes review comments as ordinary GitHub comments. Each comment is readable on
its own and carries machine-readable metadata, an _annotation_, in an HTML comment that GitHub does
not display. Any tool can read or write annotations using this document; no keys or shared state
are needed. The reference implementation is `packages/annotation-domain`.

An annotation is a hint for placing a comment on rendered Markdown. It is not signed and grants no
access: the comment author can edit or remove it, and GitHub stays the source of truth for comment
identity, authorship and edit history. Never put secrets or credentials in an annotation.

## Comment body

```markdown
> The system retries failed requests indefinitely.

Should this define a retry limit and backoff policy?

Document: [`docs/reliability.md`](https://github.com/acme/widgets/blob/0123456789abcdef0123456789abcdef01234567/docs/reliability.md?plain=1#L42-L42)

<!-- rendered-review:v1:eyJ2ZXJzaW9uIjoxLC... -->
```

Parts, separated by blank lines, in this order (empty parts are left out):

1. **Quote.** The selected text as a blockquote. Every ASCII punctuation character is
   backslash-escaped, so the quote renders as exactly the selected text (no headings, lists, links,
   HTML, `@mentions`, `#123` references or `:emoji:`). Leading and trailing spaces and tabs are
   written as `&#32;` and `&#9;`.
2. **Comment.** The reviewer's Markdown, unchanged.
3. **Permalink** (file-level review comments and PR conversation comments only, where GitHub has no
   line location). `Document: [`path`](url)` with the URL
   `https://<host>/<owner>/<repo>/blob/<commitOid>/<path>?plain=1#L<start>-L<end>`. Each path
   segment is percent-encoded; `?plain=1` opens the source view, where line anchors work.
4. **Marker.** The encoded annotation, last, on its own line.

Native line review comments also carry the quote, because GitHub shows whole lines and a Markdown
paragraph is usually a single long line.

### Suggestions

A native GitHub suggestion (on lines GitHub accepts suggestions for) is the comment, a
` ```suggestion ` block with the replacement lines, and the marker. The annotation's `motivation` is
`suggesting`.

Outside the pull request diff GitHub cannot apply suggestions. The body is then the quote, the
comment, a line saying the change must be applied manually, a ` ```diff ` block with the original
source lines prefixed `-` and the replacement lines prefixed `+`, the permalink, and the marker.

Fences are made longer than any run of backticks in their content.

### In-app display

A reader may hide the quote and an unchanged permalink line when the annotation validated (below)
and the body still starts with the quote exactly as this format would write it for the
annotation's `exact` text (after the normalization below). If the quote was edited, show the whole
body.

## Marker

```html
<!-- rendered-review:v1:<payload> -->
```

- `<payload>` is compact JSON, encoded as UTF-8, then as standard Base64 (`A–Z a–z 0–9 + /`,
  `=` padding) on a single line. The Base64 alphabet has no `-`, so it cannot end the HTML comment.
- Exactly one space separates the payload from `-->`. There is no other whitespace inside the
  marker.
- If a body contains several markers, the **last** one applies.
- The marker is recognised only by the exact text `<!-- rendered-review:v`. The pull-request link
  comment's `<!-- rendered-review-link:v1 -->` marker is a different, unrelated marker.
- Version 1 has no compression.

### Limits

| Limit              | Value                                         |
| ------------------ | --------------------------------------------- |
| Base64 payload     | 16,384 characters                             |
| Decoded JSON       | 12,288 bytes (what fits in the payload limit) |
| `prefix`, `suffix` | 64 UTF-16 code units each                     |

Writers must reject an annotation over the limit rather than truncate it: a truncated `exact` would
no longer be exact. In practice this means asking for a shorter selection.

## Schema

```ts
interface RenderedReviewAnnotationV1 {
  version: 1;
  target: {
    githubHost: string; // host name, optional port; e.g. "github.com"
    repositoryId: number; // GitHub's stable repository ID
    repository: string; // "owner/name", for readability
    pullRequest: number;
    path: string; // repository-relative, no leading "/"
    commitOid: string; // 40 or 64 lowercase hex characters
    blobOid: string; // 40 or 64 lowercase hex characters
    selectors: [
      // each type exactly once, any order
      { type: "TextQuoteSelector"; exact: string; prefix?: string; suffix?: string },
      { type: "TextPositionSelector"; start: number; end: number },
      {
        type: "MarkdownSourceRangeSelector";
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
      },
    ];
    structure?: { nodeType?: string; headingPath?: string[] };
  };
  motivation: "commenting" | "replying" | "suggesting" | "resolving";
  replyTo?: string;
  threadId?: string;
  createdBy?: "rendered-review";
}
```

The selectors follow the W3C Web Annotation Data Model's text quote and text position selectors,
plus one Markdown source range selector:

- `TextQuoteSelector`: `exact` is the selected rendered text (non-empty); `prefix` and `suffix` are
  up to 64 characters of rendered text immediately before and after it.
- `TextPositionSelector`: half-open `[start, end)` offsets into the document's rendered text.
  Non-negative integers, `end >= start`.
- `MarkdownSourceRangeSelector`: 1-based lines and columns in the raw blob. The end is exclusive,
  so a range ending at column 1 does not include that line. The end must not precede the start.

Text is compared after one normalization only: CRLF and lone CR become LF, then Unicode NFC. No
trimming, whitespace collapsing, case folding or Markdown stripping.

### Forward compatibility

Readers ignore object fields they do not know and selector objects with an unknown `type`, so
optional fields can be added to version 1. Known fields with the wrong type or an out-of-range
value make the annotation invalid. Incompatible changes use a new marker version.

## Reading states

| State       | Meaning                                                                                                                                                   | What to do                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none        | No marker                                                                                                                                                 | Treat as a plain GitHub comment                                                                                                                                         |
| ok          | Marker decodes and matches the schema                                                                                                                     | Use the selectors, after checking host, repository ID and pull request against the comment's own location, and the commit, blob, range and quote against the repository |
| damaged     | Missing `-->`, malformed version, whitespace or non-standard characters in the payload, over the size limit, invalid UTF-8 or JSON, or a schema violation | Show the full comment with a small "metadata damaged" notice and fall back to GitHub's own location                                                                     |
| unsupported | Well-formed marker with a version other than 1                                                                                                            | Show the full comment with an "unsupported version" notice and fall back                                                                                                |

A reader must never fail on a comment body, whatever it contains.
