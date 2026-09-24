// SPDX-License-Identifier: AGPL-3.0-only
import type { AnnotationSelector, RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import {
  documentText,
  type DocumentText,
  type RenderedMarkdown,
  type SourceSelection,
} from "@rendered-review/markdown-domain";

/*
 * Re-anchoring
 * ------------
 * Places an annotation made on an earlier blob onto the current one, conservatively. Quotes are
 * normalized rendered text, so they are searched in the rendered document's text (`documentText`)
 * and every hit is claimed exactly as a reader's selection would be, which yields its source range,
 * context and structure. Evidence, strongest first; the first that holds decides:
 *
 * 1. same blob -> current (confidence 1)
 * 2. an exact quote hit at the stored source offsets -> current (1)
 * 3. exactly one exact hit whose 32-character prefix and suffix both equal the stored context
 *    -> moved (0.95); of several such hits, exactly one in the stored heading path and node type
 *    -> moved (0.9)
 * 4. structural: exactly one exact hit of the stored node type that keeps its heading path or one
 *    side of its context (a renamed heading changes both the path and the prefix below it) -> moved (0.8);
 *    no exact hit, and exactly one context-anchored window of similarity >= 0.85, a single block
 *    in the stored heading path and node type -> moved (0.8 x similarity, so below 0.8)
 * 5. anything else is never placed: several exact hits -> ambiguous; otherwise unplaced, with
 *    candidates for the reader to confirm (a lone exact hit elsewhere at 0.6, context-anchored
 *    windows of similarity >= 0.4 at 0.6 x similarity).
 *
 * Unplaced is `historical-only` when the original blob is known to be renderable, `unavailable`
 * when GitHub no longer provides it, and `outdated` when that is not known.
 */

export type ReanchorState = "current" | "moved" | "outdated" | "ambiguous" | "historical-only" | "unavailable";

type Range = SourceSelection["sourceRange"];
type Offsets = SourceSelection["textPosition"];

export interface ReanchorCandidate {
  exact: string;
  textPosition: Offsets;
  sourceRange: Range;
  confidence: number;
}

export interface ReanchorResult {
  state: ReanchorState;
  /** The rung of the evidence ladder that decided the state. */
  evidence: "same-blob" | "same-range" | "quote-context" | "structure" | "none";
  /** 0 when not placed. */
  confidence: number;
  /** Where the annotation sits in the current blob (current and moved only). */
  textPosition?: Offsets;
  sourceRange?: Range;
  /** Suggested locations for the reader to confirm; never placed automatically. */
  candidates: ReanchorCandidate[];
}

export interface ReanchorInput {
  annotation: RenderedReviewAnnotationV1;
  /** The current blob, its raw source and its rendering. */
  blobOid: string;
  source: string;
  doc: RenderedMarkdown;
  /** Whether the annotation's original blob can still be rendered, when known. */
  original?: "available" | "missing";
}

const CONTEXT = 32;
const ANCHOR = 12;
const STRUCTURAL = 0.85;
const CANDIDATE = 0.4;
// ponytail: caps keep pathological inputs (a one-letter quote, a huge one) bounded; beyond them
// hits are dropped (still ambiguous) and long quotes get no fuzzy candidates.
const MAX_HITS = 200;
const MAX_FUZZY = 2000;

// ponytail: cleared when full; switch to an LRU if a session ever holds that many annotations.
const cache = new Map<string, ReanchorResult>();
const CACHE_SIZE = 5000;

type Quote = Extract<AnnotationSelector, { type: "TextQuoteSelector" }>;
const selector = <T extends AnnotationSelector["type"]>(a: RenderedReviewAnnotationV1, type: T) =>
  a.target.selectors.find((s) => s.type === type) as Extract<AnnotationSelector, { type: T }> | undefined;

/** Place `annotation` on the current blob. Pure; memoized by blob pair and annotation target. */
export function reanchor(input: ReanchorInput): ReanchorResult {
  const { target } = input.annotation;
  const key = JSON.stringify([target.blobOid, input.blobOid, input.original, target.selectors, target.structure]);
  let result = cache.get(key);
  if (!result) {
    if (cache.size >= CACHE_SIZE) cache.clear();
    cache.set(key, (result = compute(input)));
  }
  return result;
}

function compute({ annotation, blobOid, source, doc, original }: ReanchorInput): ReanchorResult {
  const { target } = annotation;
  const quote = selector(annotation, "TextQuoteSelector");
  const position = selector(annotation, "TextPositionSelector");
  const range = selector(annotation, "MarkdownSourceRangeSelector");
  if (target.blobOid === blobOid && position && range) {
    const { startLine, startColumn, endLine, endColumn } = range;
    return {
      state: "current",
      evidence: "same-blob",
      confidence: 1,
      textPosition: { start: position.start, end: position.end },
      sourceRange: { startLine, startColumn, endLine, endColumn },
      candidates: [],
    };
  }
  const unplaced = (candidates: ReanchorCandidate[]): ReanchorResult => ({
    state: original === "available" ? "historical-only" : original === "missing" ? "unavailable" : "outdated",
    evidence: "none",
    confidence: 0,
    candidates,
  });
  if (!quote) return unplaced([]);

  const text = documentText(doc, source);
  const structural = (s: SourceSelection) =>
    !!target.structure &&
    s.nodeType === target.structure.nodeType &&
    JSON.stringify(s.headingPath) === JSON.stringify(target.structure.headingPath ?? []);
  const samePrefix = (s: SourceSelection) =>
    quote.prefix !== undefined && s.prefix.slice(-CONTEXT) === quote.prefix.slice(-CONTEXT);
  const sameSuffix = (s: SourceSelection) =>
    quote.suffix !== undefined && s.suffix.slice(0, CONTEXT) === quote.suffix.slice(0, CONTEXT);
  const inContext = (s: SourceSelection) => samePrefix(s) && sameSuffix(s);
  // Rung 4 for exact hits: same kind of block, and its heading path or one side of its context kept.
  const nearby = (s: SourceSelection) =>
    s.nodeType === target.structure?.nodeType && (structural(s) || samePrefix(s) || sameSuffix(s));
  const placed = (s: SourceSelection, evidence: ReanchorResult["evidence"], confidence: number): ReanchorResult => ({
    state: evidence === "same-range" ? "current" : "moved",
    evidence,
    confidence,
    textPosition: s.textPosition,
    sourceRange: s.sourceRange,
    candidates: [],
  });
  const candidate = (s: SourceSelection, confidence: number): ReanchorCandidate => ({
    exact: s.exact,
    textPosition: s.textPosition,
    sourceRange: s.sourceRange,
    confidence,
  });

  const hits: SourceSelection[] = [];
  for (const at of occurrences(text.text, quote.exact)) {
    const r = text.select(at, at + quote.exact.length);
    if (r.ok && r.selection.exact === quote.exact) hits.push(r.selection);
  }
  if (hits.length) {
    const same = hits.find((s) => s.textPosition.start === position?.start && s.textPosition.end === position.end);
    if (same) return placed(same, "same-range", 1);
    const contextual = hits.filter(inContext);
    if (contextual.length === 1) return placed(contextual[0]!, "quote-context", 0.95);
    const pool = contextual.length ? contextual : hits;
    const structured = pool.filter(contextual.length ? structural : nearby);
    if (structured.length === 1)
      return contextual.length
        ? placed(structured[0]!, "quote-context", 0.9)
        : placed(structured[0]!, "structure", 0.8);
    if (pool.length > 1) return { ...unplaced(pool.map((s) => candidate(s, 0.6))), state: "ambiguous" };
    return unplaced([candidate(hits[0]!, 0.6)]);
  }

  const windows = fuzzy(text, quote)
    .map((s) => ({ s, similarity: similarity(quote.exact, s.exact) }))
    .filter((w) => w.similarity >= CANDIDATE)
    .sort((a, b) => b.similarity - a.similarity);
  const strong = windows.filter((w) => w.similarity >= STRUCTURAL);
  const only = strong.length === 1 ? strong[0]! : undefined;
  if (only && structural(only.s) && !only.s.expanded) return placed(only.s, "structure", 0.8 * only.similarity);
  return unplaced(windows.map((w) => candidate(w.s, 0.6 * w.similarity)));
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at >= 0 && out.length < MAX_HITS; at = text.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/**
 * Windows where the quote may have been reworded: after each occurrence of the end of its prefix
 * and before each occurrence of the start of its suffix, reaching the other anchor when it is near,
 * else the quote's length. Trimmed of surrounding whitespace, deduplicated, claimed as selections.
 */
function fuzzy(text: DocumentText, { exact, prefix, suffix }: Quote): SourceSelection[] {
  if (exact.length > MAX_FUZZY || prefix === undefined || suffix === undefined) return [];
  const t = text.text;
  const reach = Math.ceil(exact.length * 1.5) + 16;
  const p = prefix.slice(-ANCHOR);
  const s = suffix.slice(0, ANCHOR);
  const spans = new Map<string, [number, number]>();
  const add = (a: number, b: number) => {
    while (a < b && !t[a]!.trim()) a++;
    while (b > a && !t[b - 1]!.trim()) b--;
    if (b > a) spans.set(`${a}:${b}`, [a, b]);
  };
  // An empty prefix or suffix means the quote touched the document's start or end.
  for (const at of p ? occurrences(t, p) : [0]) {
    const a = at + p.length;
    const b = s ? t.indexOf(s, a) : t.length;
    add(a, b >= 0 && b - a <= reach ? b : Math.min(t.length, a + exact.length));
  }
  for (const b of s ? occurrences(t, s) : [t.length]) {
    const at = p ? t.lastIndexOf(p, b - p.length) : 0;
    const a = at + p.length;
    add(at >= 0 && b - a <= reach && a <= b ? a : Math.max(0, b - exact.length), b);
  }
  const out: SourceSelection[] = [];
  for (const [a, b] of spans.values()) {
    const r = text.select(a, b);
    if (r.ok) out.push(r.selection);
  }
  return out;
}

/** 1 - Levenshtein distance / longer length. O(a·b), only ever on quote-sized windows. */
function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}
