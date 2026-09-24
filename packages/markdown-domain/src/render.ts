// SPDX-License-Identifier: AGPL-3.0-only
import type { Element, Root as HastRoot } from "hast";
import { toString } from "hast-util-to-string";
import type { Root as MdastRoot } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Position } from "unist";
import { visit } from "unist-util-visit";
import { extractAlerts, renderAlerts } from "./alerts.js";
import { renderFrontmatter } from "./frontmatter.js";
import { markExternalLinks } from "./links.js";
import { inertMdx, labelMdx } from "./mdx.js";
import { normalizeText } from "./normalize.js";
import { resolveResources, type ResourceOptions } from "./resources.js";

/*
 * Source-map representation
 * -------------------------
 * Pipeline: remark-parse (+ remark-mdx for MDX) + remark-gfm + remark-frontmatter (YAML) -> GitHub
 * alert markers removed (./alerts.ts) -> MDX nodes made inert source (./mdx.ts) -> remark-rehype ->
 * rehype-raw -> rehype-sanitize (GitHub allowlist) -> resource resolution (./resources.ts) -> alert
 * callout markup (./alerts.ts) -> MDX labels (./mdx.ts) -> front matter
 * (./frontmatter.ts, text nodes only) -> external links (./links.ts, last so it sees every link,
 * generated or authored) -> stamping. Generated markup is added after sanitization so it can
 * carry its own classes. Stamping runs last, so authored HTML can never supply or
 * forge the markers, and the sanitizer (which keeps `position`) cannot strip them.
 *
 * - Each element with a source position gets `data-rr-id="<n>"`; `nodes[n]` holds its range,
 *   Markdown node type, heading path, normalized text and (for fences) language.
 * - Each element without a position gets `data-rr-unmapped` and is not selectable.
 * - A DOM text node belongs to its nearest stamped ancestor element. HAST text nodes also keep
 *   their own `position` for finer mapping inside an element.
 * - File path, commit and blob identity are the caller's context and are not repeated per node.
 */

/** A point in the raw source blob. Line and column are 1-based, offset is a 0-based UTF-16 index. */
export interface SourcePoint {
  line: number;
  column: number;
  offset: number;
}

/** Half-open source range: `end` points just past the last character. */
export interface SourceRange {
  start: SourcePoint;
  end: SourcePoint;
}

/** Side-table entry for one rendered element that has a source position. */
export interface SourceNode {
  /** Index into `RenderedMarkdown.nodes`; also the element's `data-rr-id` attribute. */
  id: number;
  /** Nearest enclosing mapped element, or `null` at the top level. */
  parentId: number | null;
  /**
   * Markdown node type (`paragraph`, `heading`, `code`, `tableCell`, `emphasis`, ...) when the
   * element corresponds exactly to an mdast node, `part` for `thead`/`tbody`, otherwise `html`
   * (an element parsed from raw HTML). Front matter is `yaml` (the block), `yamlEntry` (one
   * top-level key and its value), `yamlKey` and `yamlValue`. Inert MDX source keeps its MDX node
   * type (`mdxjsEsm`, `mdxFlowExpression`, `mdxJsxFlowElement`, `mdxJsxTextElement`,
   * `mdxTextExpression`); a JSX element's opening and closing tags are `mdxJsxTag`.
   */
  type: string;
  tagName: string;
  range: SourceRange;
  /** Normalized text of the enclosing headings, outermost first. A heading includes itself. */
  headingPath: string[];
  /** Normalized rendered text content. */
  text: string;
  /** Fenced code only: the info-string language (`mermaid`, `ts`, ...). `range` covers the whole fence. */
  lang?: string;
}

export interface RenderedMarkdown {
  /** Sanitized HAST tree; render with e.g. `hast-util-to-jsx-runtime`, never as an HTML string. */
  tree: HastRoot;
  /** Every source-mapped element, in document (pre-)order. */
  nodes: SourceNode[];
}

const BLOCK_TYPES = new Set([
  "mdxFlowExpression",
  "mdxJsxFlowElement",
  "mdxjsEsm",
  "blockquote",
  "code",
  "footnoteDefinition",
  "heading",
  "listItem",
  "paragraph",
  "tableRow",
  "thematicBreak",
  "yaml",
  "yamlEntry",
]);

// remark-rehype gives these the position of their first/only row; they are not Markdown nodes.
const STRUCTURAL = new Set(["thead", "tbody"]);

export interface RenderOptions extends ResourceOptions {
  /** `mdx` parses MDX syntax (JSX, ESM, expressions) and shows it as inert source. Default `md`. */
  format?: "md" | "mdx";
}

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).freeze();
const mdxParser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).use(remarkFrontmatter).freeze();
const toSafeHast = unified()
  // Ids are left bare here so the sanitizer's clobber prefix yields GitHub's `user-content-` ids.
  .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: "" })
  .use(rehypeRaw)
  // The default schema is GitHub's allowlist. It keeps `position`, and it strips every
  // `data-*` attribute authors could use to forge the `data-rr-*` markers added below.
  .use(rehypeSanitize)
  .freeze();

const key = (p: Position) => `${p.start.offset}:${p.end.offset}`;

/**
 * Parse GitHub Flavored Markdown into a sanitized, source-mapped HAST tree.
 *
 * Pure and deterministic: the same `source` and `options` always yield the same output, so callers
 * may cache it by blob identity and location. `options` resolves repository-relative links and
 * images and applies the external-image policy (see `resolveResources`). `source` must be the raw
 * blob text; positions refer to it unchanged.
 *
 * Every element with a source position gets `data-rr-id` (an index into `nodes`). Elements the
 * pipeline generates without a position (footnote section heading, back-references, task-list
 * checkboxes, ...) get `data-rr-unmapped` and must not be offered as selectable.
 *
 * With `format: "mdx"`, MDX is parsed but never evaluated: JSX, imports/exports and expressions render
 * as labelled source (see ./mdx.ts). Invalid MDX throws `Invalid MDX[ at line L, column C]: reason`.
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): RenderedMarkdown {
  const mdast = parse(source, options.format === "mdx");
  const alerts = extractAlerts(mdast, source);
  const mdxLabels = inertMdx(mdast, source);

  // Every mdast node per range, outermost first: nested elements with one range (a single-item
  // list and its item, a paragraph that is all emphasis) take them in order.
  const mdastTypes = new Map<string, { type: string; lang?: string }[]>();
  visit(mdast, (node) => {
    if (node.type === "root" || !node.position) return;
    const k = key(node.position);
    const md = { type: node.type, lang: node.type === "code" ? (node.lang ?? undefined) : undefined };
    mdastTypes.set(k, [...(mdastTypes.get(k) ?? []), md]);
  });

  const tree = toSafeHast.runSync(structuredClone(mdast)) as HastRoot;
  resolveResources(tree, options);
  renderAlerts(tree, alerts);
  labelMdx(tree, mdxLabels);
  const first = mdast.children[0];
  if (first?.type === "yaml") {
    const front = renderFrontmatter(source, first);
    for (const [p, type] of front.types) mdastTypes.set(key(p), [{ type }]);
    tree.children.unshift(front.element, { type: "text", value: "\n" });
  }
  markExternalLinks(tree);
  const nodes: SourceNode[] = [];
  const headings: { depth: number; text: string }[] = [];

  // `nth`: how many enclosing elements share this element's range.
  const walk = (el: Element, parentId: number | null, topLevel: boolean, parentKey = "", nth = 0) => {
    const pos = el.position;
    if (pos?.start.offset === undefined || pos.end.offset === undefined) {
      el.properties.dataRrUnmapped = true;
      for (const child of el.children) if (child.type === "element") walk(child, parentId, false);
      return;
    }
    const k = key(pos);
    if (k !== parentKey) nth = 0;
    const text = normalizeText(toString(el));
    const depth = topLevel ? Number(/^h([1-6])$/.exec(el.tagName)?.[1] ?? 0) : 0;
    if (depth) {
      while (headings.length && headings[headings.length - 1]!.depth >= depth) headings.pop();
      headings.push({ depth, text });
    }
    const types = mdastTypes.get(k);
    const md = STRUCTURAL.has(el.tagName) ? undefined : types?.[Math.min(nth, types.length - 1)];
    const id = nodes.length;
    el.properties.dataRrId = id;
    nodes.push({
      id,
      parentId,
      type: md?.type ?? (STRUCTURAL.has(el.tagName) ? "part" : "html"),
      tagName: el.tagName,
      range: { start: { ...pos.start, offset: pos.start.offset }, end: { ...pos.end, offset: pos.end.offset } },
      headingPath: headings.map((h) => h.text),
      text,
      ...(md?.lang ? { lang: md.lang } : {}),
    });
    for (const child of el.children) if (child.type === "element") walk(child, id, false, k, nth + 1);
  };
  for (const child of tree.children) if (child.type === "element") walk(child, null, true);

  return { tree, nodes };
}

function parse(source: string, mdx: boolean): MdastRoot {
  if (!mdx) return markdownParser.runSync(markdownParser.parse(source)) as MdastRoot;
  try {
    return mdxParser.runSync(mdxParser.parse(source)) as MdastRoot;
  } catch (error) {
    const { line, column, reason } = error as { line?: number; column?: number; reason?: string };
    const at = line ? ` at line ${line}, column ${column}` : "";
    throw new Error(`Invalid MDX${at}: ${reason ?? String(error)}`, { cause: error });
  }
}

/**
 * Innermost rendered blocks overlapping the 1-based, inclusive source line range, in document
 * order. Used to place line-based comments (e.g. native GitHub review comments) on blocks
 * without claiming finer precision. A fence yields its whole code block.
 */
export function blocksForLines(doc: RenderedMarkdown, startLine: number, endLine: number): SourceNode[] {
  const hits = doc.nodes.filter(
    (n) => isBlock(doc, n) && n.range.start.line <= endLine && lastLine(n.range) >= startLine,
  );
  const hitIds = new Set(hits.map((n) => n.id));
  // Drop any hit that has a descendant hit, and the inner twin of a same-range pair (pre > code).
  const covered = new Set<number>();
  for (const n of hits) {
    for (let p = n.parentId; p !== null; p = doc.nodes[p]!.parentId) {
      if (!hitIds.has(p)) continue;
      const parent = doc.nodes[p]!;
      if (key(parent.range) === key(n.range)) covered.add(n.id);
      else covered.add(p);
    }
  }
  return hits.filter((n) => !covered.has(n.id));
}

/** Raw HTML counts as a block at the top level or nested in raw HTML, not inline in Markdown text. */
export function isBlock(doc: RenderedMarkdown, n: SourceNode): boolean {
  if (n.type !== "html") return BLOCK_TYPES.has(n.type);
  return n.parentId === null || doc.nodes[n.parentId]!.type === "html";
}

/** Last line containing a character of the range (an end at column 1 belongs to the previous line). */
function lastLine(r: SourceRange): number {
  return r.end.column === 1 && r.end.line > r.start.line ? r.end.line - 1 : r.end.line;
}
