// SPDX-License-Identifier: AGPL-3.0-only
import type { Element, ElementContent } from "hast";
import type { Yaml } from "mdast";
import type { Point, Position } from "unist";
import { isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";

// ponytail: fixed cap; larger front matter shows as raw code.
const MAX_CHARS = 64 * 1024;

export interface RenderedFrontmatter {
  element: Element;
  /** Source node type for each positioned element that is not the front matter block itself. */
  types: [Position, string][];
}

/**
 * YAML front matter as `<dl class="rr-frontmatter">`: one `<div><dt>key</dt><dd>value</dd></div>`
 * row per top-level key, each positioned on its own source lines. Strings show their parsed value,
 * other scalars (and transformed strings) and nested collections their YAML source, lists of scalars an inner `<ul>`.
 * Invalid, oversized or non-mapping YAML falls back to `<pre class="rr-frontmatter"><code>`.
 *
 * Everything is built from text nodes; the YAML is parsed to an AST only (no tags, no alias
 * expansion, no conversion to JS objects), so it cannot inject markup or run code.
 */
export function renderFrontmatter(source: string, node: Yaml): RenderedFrontmatter {
  const start = node.position!.start.offset!;
  const end = node.position!.end.offset!;
  // Content lies between the opening fence's line ending and the closing fence's.
  const from = source.indexOf("\n", start) + 1;
  const closing = source.lastIndexOf("\n", end - 1);
  const to = Math.max(from, source[closing - 1] === "\r" ? closing - 1 : closing);
  const raw = source.slice(from, to);
  const block = position(source, start, end);
  const types: [Position, string][] = [];
  const text = (value: string): ElementContent => ({ type: "text", value });
  const el = (tagName: string, range: [number, number], type: string, children: ElementContent[]): Element => {
    const pos = position(source, from + range[0], from + range[1]);
    types.push([pos, type]);
    return { type: "element", tagName, properties: {}, children, position: pos };
  };
  // A node's source span without trailing whitespace (block collections end after a line break).
  const span = (n: YamlNode): [number, number] => {
    const [s, e] = n.range!;
    return [s, s + raw.slice(s, e).trimEnd().length];
  };
  const slice = (n: YamlNode) => raw.slice(...span(n));
  const fallback = (): RenderedFrontmatter => ({
    element: {
      type: "element",
      tagName: "pre",
      properties: { className: ["rr-frontmatter"] },
      children: [{ type: "element", tagName: "code", properties: {}, children: [text(raw)], position: block }],
      position: block,
    },
    types: [],
  });

  if (raw.length > MAX_CHARS) return fallback();
  let doc;
  try {
    doc = parseDocument(raw, { schema: "core" });
  } catch {
    return fallback(); // e.g. stack exhaustion on pathological nesting
  }
  if (doc.errors.length || !isMap(doc.contents)) return fallback();

  // Strings show their parsed value while it appears verbatim in the source; folded, escaped or
  // non-string scalars show their source, so rendered text always maps back to source text.
  const scalarText = (v: YamlNode) => {
    const src = slice(v);
    const parsed = isScalar(v) && typeof v.value === "string" ? v.value.trim() : undefined;
    if (parsed !== undefined && src.includes(parsed)) return parsed;
    return isScalar(v) && (v.type === "BLOCK_FOLDED" || v.type === "BLOCK_LITERAL")
      ? src.slice(src.indexOf("\n") + 1).trim()
      : src;
  };
  const value = (v: YamlNode): ElementContent[] => {
    if (isScalar(v)) return [text(scalarText(v))];
    if (isSeq(v) && v.items.every(isScalar))
      return [
        el(
          "ul",
          span(v),
          "yamlValue",
          v.items.map((i) => el("li", span(i), "yamlValue", value(i))),
        ),
      ];
    return [el("code", span(v), "yamlValue", [text(slice(v))])];
  };

  const rows = doc.contents.items.map((pair) => {
    const k = pair.key as YamlNode;
    const v = pair.value as YamlNode | null;
    const rowEnd = span(v ?? k)[1];
    const dd = el("dd", v ? span(v) : [rowEnd, rowEnd], "yamlValue", v ? value(v) : []);
    return el("div", [k.range![0], rowEnd], "yamlEntry", [el("dt", span(k), "yamlKey", [text(scalarText(k))]), dd]);
  });
  return {
    element: {
      type: "element",
      tagName: "dl",
      properties: { className: ["rr-frontmatter"] },
      children: rows,
      position: block,
    },
    types,
  };
}

function position(source: string, start: number, end: number): Position {
  return { start: pointAt(source, start), end: pointAt(source, end) };
}

/** The source point at a 0-based offset. */
export function pointAt(source: string, offset: number): Point {
  const before = source.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n"), offset };
}
