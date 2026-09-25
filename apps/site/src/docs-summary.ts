// SPDX-License-Identifier: AGPL-3.0-only
// A doc's opening paragraph as plain text, for its meta description and the docs home.

export function summary(markdown: string, max = 160): string {
  const paragraph =
    markdown
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block && !/^(#|```|\||[-*] |\d+\. |>|<)/.test(block)) ?? "";
  const text = paragraph
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  // Up to `max` characters, ending on a whole word.
  return `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}
