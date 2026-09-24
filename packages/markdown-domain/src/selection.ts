// SPDX-License-Identifier: AGPL-3.0-only
import type { Element, Root } from "hast";
import type { Position } from "unist";
import { pointAt } from "./frontmatter.js";
import { normalizeText } from "./normalize.js";
import { isBlock, type RenderedMarkdown, type SourceNode, type SourcePoint } from "./render.js";

/*
 * Selection conversion
 * --------------------
 * A rendered point is a stamped element (`data-rr-id`) and a UTF-16 offset into the text of its
 * subtree, in document order, counting every text node, generated ones included (what the DOM
 * shows). The rendered document's text is the concatenation of every HAST text node, except
 * whitespace directly inside table structure (React drops it too).
 *
 * Each text node is one segment:
 * - `chrome`: inside an unmapped (generated) element: alert titles, MDX labels, footnote labels
 *   and back-links. Never claimed; selection ends inside it move inward to document text.
 * - `gap`: unpositioned whitespace between elements. Selection ends move inward past it.
 * - `text`: everything else. Each character maps to a source span:
 *   - text with its own position aligns against it character by character: equal characters
 *     map 1:1, a character reference maps to all of `&...;`, an escaped character to `\x`, and
 *     unmatched source (markup, indentation, `>` markers) belongs to no character, so a selection
 *     claims it only when it lies between selected characters;
 *   - the only text of an element without its own position (code blocks, inert MDX, front matter
 *     values, task-list items) aligns the same way against the element's range (a fence's content
 *     starts after its opening line);
 *   - anything that does not align claims the whole span (never narrower than defensible).
 */

/** A position in the rendered document: stamped element id and text offset within it. */
export interface RenderedPoint {
  id: number;
  offset: number;
}

/** Converted selection. Offsets and lines/columns refer to the raw source; ends are exclusive. */
export interface SourceSelection {
  /** Normalized rendered text of the claimed range, without generated labels. */
  exact: string;
  /** Up to 32 characters of normalized rendered text before and after `exact`. */
  prefix: string;
  suffix: string;
  /** 0-based UTF-16 offsets into the raw source; `end` is exclusive. */
  textPosition: { start: number; end: number };
  /** 1-based; `endColumn` is just past the last claimed character. */
  sourceRange: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  /** Markdown type of the innermost block (or table cell / front matter key or value) containing the selection; `root` for top-level expansions. */
  nodeType: string;
  headingPath: string[];
  /** Blocks the claim covers (`SourceNode` ids). */
  blockIds: number[];
  /** The selection crossed blocks and was widened to whole blocks. */
  expanded: boolean;
}

export type SelectionRejection = "empty" | "generated" | "frontmatter";

export type SelectionResult =
  { ok: true; selection: SourceSelection } | { ok: false; reason: SelectionRejection; message: string };

const CONTEXT = 32;
const TABLE = new Set(["table", "thead", "tbody", "tfoot", "tr"]);
const CELLS = new Set(["tableCell", "yamlKey", "yamlValue"]);
// Phrasing elements in raw HTML are inline, wherever they are nested.
const PHRASING = new Set(
  "a abbr b bdi bdo br cite code data del dfn em i img ins kbd mark q s samp small span strong sub sup time u var".split(
    " ",
  ),
);
const REF = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|[A-Za-z][A-Za-z0-9]{1,31});/y;
const PUNCT = /[!-/:-@[-`{-~]/;

const MESSAGES: Record<SelectionRejection, string> = {
  empty: "Select some document text to comment on.",
  generated: "Generated labels are not part of the document; select document text instead.",
  frontmatter: "A selection cannot span the front matter and the document body.",
};

/** A rejected selection, with the reason shown to the reader. */
export const rejectSelection = (reason: SelectionRejection): SelectionResult => ({
  ok: false,
  reason,
  message: MESSAGES[reason],
});

interface Segment {
  text: string;
  /** Offset in the rendered document's text. */
  at: number;
  owner: number | null;
  chrome: boolean;
  position?: Position;
  kind?: "text" | "gap" | "chrome";
  /** Source span [start, end) per character, interleaved. */
  spans?: Int32Array;
  base?: SourcePoint;
}

interface Index {
  segments: Segment[];
  /** Rendered text extent [from, to) of each stamped element. */
  extent: [number, number][];
}

const indexes = new WeakMap<RenderedMarkdown, Index>();

/** One pass over the tree per rendered document; cached, so conversions never reparse or rewalk. */
function indexOf(doc: RenderedMarkdown): Index {
  let index = indexes.get(doc);
  if (index) return index;
  const segments: Segment[] = [];
  const extent: [number, number][] = [];
  let at = 0;
  const walk = (el: Root | Element, owner: number | null, chrome: boolean) => {
    for (const c of el.children) {
      if (c.type === "text") {
        if (el.type === "element" && TABLE.has(el.tagName) && !c.value.trim()) continue;
        segments.push({ text: c.value, at, owner, chrome, position: c.position });
        at += c.value.length;
      } else if (c.type === "element") {
        const id = c.properties.dataRrId as number | undefined;
        if (id === undefined) walk(c, owner, true);
        else {
          const from = at;
          walk(c, id, false);
          extent[id] = [from, at];
        }
      }
    }
  };
  walk(doc.tree, null, false);
  index = { segments, extent };
  indexes.set(doc, index);
  return index;
}

/** Index of the last segment starting at or before `offset`. */
function segmentAt(segments: { at: number }[], offset: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.at <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function kindOf(doc: RenderedMarkdown, ix: Index, seg: Segment): Segment["kind"] {
  if (seg.kind) return seg.kind;
  if (seg.chrome) return (seg.kind = "chrome");
  if (seg.position?.start.offset !== undefined) return (seg.kind = "text");
  if (seg.owner === null) return (seg.kind = "gap");
  if (!seg.text.trim() && textCount(ix, seg.owner) > 1) return (seg.kind = "gap");
  return (seg.kind = "text");
}

/** Non-generated text segments inside a stamped element. */
function textCount(ix: Index, id: number): number {
  const [from, to] = ix.extent[id]!;
  let n = 0;
  for (let k = segmentAt(ix.segments, from); k < ix.segments.length && ix.segments[k]!.at < to; k++) {
    const s = ix.segments[k]!;
    if (s.at >= from && s.text && !s.chrome) n++;
  }
  return n;
}

/** Source span per character of a `text` segment. */
function spansOf(doc: RenderedMarkdown, ix: Index, source: string, seg: Segment): Int32Array {
  if (seg.spans) return seg.spans;
  let from: number;
  let to: number;
  let aligned: Int32Array | null = null;
  if (seg.position?.start.offset !== undefined) {
    from = seg.position.start.offset;
    to = seg.position.end.offset!;
    seg.base = { ...seg.position.start, offset: from };
    aligned = align(seg.text, source, from, to);
  } else {
    const range = doc.nodes[seg.owner!]!.range;
    from = range.start.offset;
    to = range.end.offset;
    seg.base = range.start;
    if (textCount(ix, seg.owner!) === 1) {
      // A fence's content starts on the line after the opening fence.
      const content = /^(`{3,}|~{3,})/.test(source.slice(from, from + 3)) ? source.indexOf("\n", from) + 1 : from;
      aligned = align(seg.text, source, content > from ? content : from, to);
    }
  }
  if (!aligned) {
    aligned = new Int32Array(seg.text.length * 2);
    for (let i = 0; i < seg.text.length; i++) aligned.set([from, to], i * 2);
  }
  return (seg.spans = aligned);
}

/** Map each character of rendered `text` to its source span within `source[from, to)`, or null. */
function align(text: string, source: string, from: number, to: number): Int32Array | null {
  const out = new Int32Array(text.length * 2);
  let i = 0;
  let j = from;
  const put = (n: number, s: number, e: number) => {
    for (let k = 0; k < n; k++) out.set([s, e], (i + k) * 2);
    i += n;
    j = e;
  };
  while (i < text.length && j < to) {
    const c = text[i]!;
    const s = source[j]!;
    REF.lastIndex = j;
    const ref = s === "&" ? REF.exec(source) : null;
    if (ref && j + ref[0].length <= to && !text.startsWith(ref[0], i)) {
      const cp = ref[1] ? Number(ref[1]) : ref[2] ? parseInt(ref[2], 16) : text.codePointAt(i)!;
      put(Math.min(cp > 0xffff && cp <= 0x10ffff ? 2 : 1, text.length - i), j, j + ref[0].length);
    } else if (s === "\\" && source[j + 1] === c && j + 1 < to && PUNCT.test(c)) put(1, j, j + 2);
    else if (c === s || (c === " " && (s === "\n" || s === "\r"))) put(1, j, j + 1);
    else j++;
  }
  // Generated trailing whitespace (e.g. before a footnote's back-link) claims nothing.
  while (i < text.length && !text[i]!.trim()) put(1, to, to);
  return i === text.length ? out : null;
}

/** The source point at `offset`, counted forward from a known point at or before it. */
function advance(source: string, from: SourcePoint, offset: number): SourcePoint {
  if (offset < from.offset) return pointAt(source, offset) as SourcePoint;
  let { line, column } = from;
  for (let j = from.offset; j < offset; j++) {
    if (source[j] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column, offset };
}

function ancestors(doc: RenderedMarkdown, id: number): number[] {
  const chain = [id];
  for (let p = doc.nodes[id]!.parentId; p !== null; p = doc.nodes[p]!.parentId) chain.push(p);
  return chain;
}

function common(doc: RenderedMarkdown, a: number, b: number): number | null {
  const chain = new Set(ancestors(doc, a));
  return ancestors(doc, b).find((id) => chain.has(id)) ?? null;
}

const blockish = (doc: RenderedMarkdown, n: SourceNode) =>
  isBlock(doc, n) && !(n.type === "html" && n.parentId !== null && PHRASING.has(n.tagName));

const sameRange = (a: SourceNode, b: SourceNode) =>
  a.range.start.offset === b.range.start.offset && a.range.end.offset === b.range.end.offset;

/** The block containing `id`; of a same-range pair (pre > code), the outer one, as `blocksForLines` picks. */
function blockOf(doc: RenderedMarkdown, id: number): SourceNode {
  let n = doc.nodes[id]!;
  while (!blockish(doc, n) && n.parentId !== null) n = doc.nodes[n.parentId]!;
  while (n.parentId !== null && sameRange(n, doc.nodes[n.parentId]!)) n = doc.nodes[n.parentId]!;
  return n;
}

/** The ancestor-or-self of `id` whose parent is `parent`. */
function childOf(doc: RenderedMarkdown, id: number, parent: number | null): SourceNode {
  let n = doc.nodes[id]!;
  while (n.parentId !== parent) n = doc.nodes[n.parentId!]!;
  return n;
}

const inFrontmatter = (doc: RenderedMarkdown, id: number) =>
  ancestors(doc, id).some((a) => doc.nodes[a]!.type === "yaml");

/**
 * Convert a rendered selection `[start, end)` into the source it claims. `source` is the raw blob
 * `doc` was rendered from. Ends inside generated labels or inter-block whitespace move inward.
 * Within one block the claim is the tightest source span that contains the selected characters.
 * Across blocks it widens to the whole blocks below their common ancestor (`expanded`), and
 * `exact` becomes those blocks' text. Crossing between front matter and body is rejected.
 * Cost is proportional to the selection, after one cached walk per document.
 */
export function selectionToSource(
  doc: RenderedMarkdown,
  source: string,
  start: RenderedPoint,
  end: RenderedPoint,
): SelectionResult {
  const ix = indexOf(doc);
  const g0 = ix.extent[start.id]![0] + start.offset;
  const g1 = ix.extent[end.id]![0] + end.offset;
  if (g1 <= g0) return rejectSelection("empty");
  let clamped = clamp(doc, ix, g0, g1);
  if (!clamped) return rejectSelection("generated");
  let [k0, a, k1, b] = clamped;
  const first = ix.segments[k0]!;
  const last = ix.segments[k1]!;
  const sb = blockOf(doc, first.owner!);
  const eb = blockOf(doc, last.owner!);

  let from: SourcePoint;
  let to: SourcePoint;
  let nodeType: string;
  let blockIds: number[];
  const expanded = sb.id !== eb.id;
  if (!expanded) {
    const s = spansOf(doc, ix, source, first)[(a - first.at) * 2]!;
    const e = spansOf(doc, ix, source, last)[(b - 1 - last.at) * 2 + 1]!;
    from = advance(source, first.base!, Math.min(s, e));
    to = advance(source, from, Math.max(s, e));
    let n = doc.nodes[common(doc, first.owner!, last.owner!)!]!;
    while (!blockish(doc, n) && !CELLS.has(n.type) && n.parentId !== null) n = doc.nodes[n.parentId]!;
    nodeType = n.type;
    blockIds = [sb.id];
  } else {
    if (inFrontmatter(doc, sb.id) !== inFrontmatter(doc, eb.id)) return rejectSelection("frontmatter");
    const lca = common(doc, sb.id, eb.id);
    const [x, y] =
      lca === sb.id || lca === eb.id
        ? [doc.nodes[lca]!, doc.nodes[lca]!]
        : [childOf(doc, sb.id, lca), childOf(doc, eb.id, lca)];
    from = x.range.start.offset <= y.range.start.offset ? x.range.start : y.range.start;
    to = x.range.end.offset >= y.range.end.offset ? x.range.end : y.range.end;
    nodeType = lca === null ? "root" : doc.nodes[lca]!.type;
    blockIds = x === y ? [x.id] : [];
    for (let id = x.id; x !== y && id <= y.id; id++) if (doc.nodes[id]!.parentId === x.parentId) blockIds.push(id);
    clamped = clamp(doc, ix, ix.extent[x.id]![0], ix.extent[y.id]![1])!;
    [k0, a, k1, b] = clamped;
  }

  return {
    ok: true,
    selection: {
      exact: normalizeText(textBetween(ix, k0, a, k1, b)),
      prefix: context(ix, k0, a, -1),
      suffix: context(ix, k1, b, 1),
      textPosition: { start: from.offset, end: to.offset },
      sourceRange: { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column },
      nodeType,
      headingPath: sb.headingPath,
      blockIds,
      expanded,
    },
  };
}

/** Move `[g0, g1)` inward onto document text: `[startSegment, g0, endSegment, g1]`, or null if none is left. */
function clamp(doc: RenderedMarkdown, ix: Index, g0: number, g1: number): [number, number, number, number] | null {
  const segs = ix.segments;
  let k0 = segmentAt(segs, g0);
  while (k0 < segs.length) {
    const s = segs[k0]!;
    if (g0 < s.at + s.text.length && kindOf(doc, ix, s) === "text") break;
    k0++;
    if (k0 < segs.length) g0 = Math.max(g0, segs[k0]!.at);
  }
  let k1 = segmentAt(segs, g1 - 1);
  while (k1 >= 0) {
    const s = segs[k1]!;
    if (g1 > s.at && kindOf(doc, ix, s) === "text") break;
    k1--;
    if (k1 >= 0) g1 = Math.min(g1, segs[k1]!.at + segs[k1]!.text.length);
  }
  return k0 < segs.length && k1 >= 0 && g0 < g1 ? [k0, g0, k1, g1] : null;
}

function textBetween(ix: Index, k0: number, g0: number, k1: number, g1: number): string {
  let out = "";
  for (let k = k0; k <= k1; k++) {
    const s = ix.segments[k]!;
    if (!s.chrome) out += s.text.slice(Math.max(0, g0 - s.at), Math.min(s.text.length, g1 - s.at));
  }
  return out;
}

/** Up to `CONTEXT` characters of normalized document text before (`dir` -1) or after (1) offset `g` in segment `k`. */
function context(ix: Index, k: number, g: number, dir: -1 | 1): string {
  let out = "";
  for (; k >= 0 && k < ix.segments.length && out.length < CONTEXT * 2; k += dir) {
    const s = ix.segments[k]!;
    if (s.chrome) continue;
    if (dir < 0) out = s.text.slice(0, Math.max(0, g - s.at)) + out;
    else out += s.text.slice(Math.max(0, g - s.at));
  }
  const text = normalizeText(out);
  return dir < 0 ? text.slice(-CONTEXT) : text.slice(0, CONTEXT);
}

/** A highlighted run of rendered text, `[start, end)`. */
export interface RenderedRun {
  start: RenderedPoint;
  end: RenderedPoint;
}

/**
 * The rendered text a source range claims, as runs in document order: every document character
 * whose source span lies inside `range` (raw offsets, `end` exclusive). Generated labels and
 * unclaimed characters split runs. Re-highlights a stored claim exactly as it was selected.
 */
export function sourceToRendered(
  doc: RenderedMarkdown,
  source: string,
  range: { start: number; end: number },
): RenderedRun[] {
  const ix = indexOf(doc);
  const runs: RenderedRun[] = [];
  let run: RenderedRun | null = null;
  const point = (owner: number, g: number) => ({ id: owner, offset: g - ix.extent[owner]![0] });
  for (const seg of ix.segments) {
    const kind = kindOf(doc, ix, seg);
    if (kind === "gap") continue;
    // ponytail: scans every segment per call; index segments by source offset if many claims get slow.
    const bound =
      seg.position?.start.offset !== undefined ? seg.position : seg.owner !== null && doc.nodes[seg.owner]!.range;
    if (kind === "chrome" || !bound || bound.end.offset! <= range.start || bound.start.offset! >= range.end) {
      run = null;
      continue;
    }
    const spans = spansOf(doc, ix, source, seg);
    for (let i = 0; i < seg.text.length; i++) {
      const [s, e] = [spans[i * 2]!, spans[i * 2 + 1]!];
      if (s < e && s >= range.start && e <= range.end) {
        if (!run) runs.push((run = { start: point(seg.owner!, seg.at + i), end: point(seg.owner!, seg.at + i) }));
        run.end = point(seg.owner!, seg.at + i + 1);
      } else run = null;
    }
  }
  return runs;
}

/** The document's searchable text; see `documentText`. */
export interface DocumentText {
  /** Normalized rendered text of the whole document, without generated labels: what quotes are cut from. */
  text: string;
  /** Claim `text[start, end)` exactly as a rendered selection of those characters would. */
  select(start: number, end: number): SelectionResult;
}

const documentTexts = new WeakMap<RenderedMarkdown, DocumentText>();

/**
 * Search the rendered document the way selections quote it: `text` is every non-generated text
 * node, concatenated and normalized, so a stored `exact` quote is found with `indexOf`, and any
 * hit goes back through `selectionToSource` for its source claim, context and structure. Cached.
 */
export function documentText(doc: RenderedMarkdown, source: string): DocumentText {
  const cached = documentTexts.get(doc);
  if (cached) return cached;
  const ix = indexOf(doc);
  // Raw searchable offset of each non-generated segment, parallel to `segs`.
  const segs = ix.segments.filter((s) => !s.chrome);
  const starts: number[] = [];
  let raw = "";
  for (const s of segs) {
    starts.push(raw.length);
    raw += s.text;
  }
  const { text, map } = normalizeMapped(raw);
  const toRaw = (i: number) => (map ? map[i]! : i);
  const keyed = starts.map((at) => ({ at }));
  // The segment holding raw offset `r`, moved `dir` to one with an owner (not a top-level gap).
  const segmentOf = (r: number, dir: 1 | -1) => {
    let k = segmentAt(keyed, r);
    while (segs[k] && segs[k]!.owner === null) k += dir;
    return k;
  };
  const point = (k: number, r: number): RenderedPoint => {
    const s = segs[k]!;
    return { id: s.owner!, offset: s.at + (r - starts[k]!) - ix.extent[s.owner!]![0] };
  };
  const result: DocumentText = {
    text,
    select(start, end) {
      if (end <= start) return rejectSelection("empty");
      const r0 = toRaw(start);
      const r1 = toRaw(end);
      const k0 = segmentOf(r0, 1);
      const k1 = segmentOf(r1 - 1, -1);
      if (!segs[k0] || !segs[k1] || k1 < k0) return rejectSelection("empty");
      const a = Math.max(r0, starts[k0]!);
      const b = Math.min(r1, starts[k1]! + segs[k1]!.text.length);
      return selectionToSource(doc, source, point(k0, a), point(k1, b));
    },
  };
  documentTexts.set(doc, result);
  return result;
}

/**
 * `normalizeText(raw)` with the raw offset of each normalized character (plus one past the end),
 * or a null map when normalizing changes nothing. Normalizes per CRLF and per base character with
 * its combining marks.
 * ponytail: NFC compositions across a base character (Hangul jamo sequences) are not joined, so
 * such a quote is not found; normalize whole runs if that ever matters.
 */
function normalizeMapped(raw: string): { text: string; map: number[] | null } {
  if (normalizeText(raw) === raw) return { text: raw, map: null };
  let text = "";
  const map: number[] = [];
  for (const m of raw.matchAll(/\r\n|\P{M}\p{M}*|\p{M}+/gsu)) {
    const out = normalizeText(m[0]);
    for (let i = 0; i < out.length; i++) map.push(m.index);
    text += out;
  }
  map.push(raw.length);
  return { text, map };
}
