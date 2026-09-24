// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one text normalization used for selection, validation and re-anchoring.
 *
 * Rules, applied in this order and nothing else:
 * 1. Line endings: every CRLF (`\r\n`) and lone CR (`\r`) becomes LF (`\n`).
 * 2. Unicode: the result is converted to Normalization Form C (NFC).
 *
 * Deliberately NOT done: trimming, collapsing or converting whitespace (tabs,
 * non-breaking spaces, repeated spaces stay as they are), case folding,
 * removing or replacing punctuation, stripping Markdown syntax, or decoding
 * entities. Any of those could make two different texts compare equal.
 *
 * Source positions always refer to the raw, un-normalized blob; normalize only
 * the strings you compare.
 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").normalize("NFC");
}
