// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="remark-mdx" />
import type { Element, Root as HastRoot } from "hast";
import type { Parent, Root as MdastRoot, RootContent } from "mdast";
import type { Position } from "unist";
import { pointAt } from "./frontmatter.js";

const INLINE = "MDX";
const key = (p: Position) => `${p.start.offset}:${p.end.offset}`;

/**
 * Make MDX nodes inert: imports/exports, `{expressions}`, JSX elements without children and every
 * inline JSX element or expression become their exact source text as `<pre><code>` (flow, wrapped in
 * a positioned `<div>`) or `<code>` (inline). A flow JSX element with children keeps them as
 * Markdown, between its opening and closing tags' source (each its own positioned `<pre>`), so every
 * rendered piece is an exact source slice. Nothing is evaluated: the MDX parser only builds a syntax tree.
 *
 * Returns the label for each transformed node, keyed by its source range, for `labelMdx`.
 */
export function inertMdx(mdast: MdastRoot, source: string): Map<string, string> {
  const labels = new Map<string, string>();
  const text = (p: Position) => ({ type: "text" as const, value: source.slice(p.start.offset, p.end.offset) });
  const pre = (p: Position): Element => ({
    type: "element",
    tagName: "pre",
    properties: {},
    children: [{ type: "element", tagName: "code", properties: {}, children: [text(p)], position: p }],
    position: p,
  });
  // A JSX tag's source between `from` and `to`, without the surrounding whitespace.
  const tag = (from: number, to: number) => {
    const s = source.slice(from, to);
    const p = {
      start: pointAt(source, from + s.length - s.trimStart().length),
      end: pointAt(source, from + s.trimEnd().length),
    };
    return {
      type: "mdxJsxTag",
      children: [],
      position: p,
      data: { hName: "pre", hChildren: pre(p).children },
    } as unknown as RootContent;
  };
  const walk = (parent: Parent) => {
    for (const node of parent.children) {
      const p = node.position!;
      switch (node.type) {
        case "mdxjsEsm":
        case "mdxFlowExpression":
          labels.set(key(p), node.type === "mdxjsEsm" ? "MDX import/export" : "MDX expression");
          node.data = { hName: "div", hChildren: [pre(p)] };
          break;
        case "mdxJsxFlowElement": {
          labels.set(key(p), `MDX component <${node.name ?? ""}>`);
          const first = node.children[0]?.position;
          const last = node.children.at(-1)?.position;
          if (!first || !last) {
            node.data = { hName: "div", hChildren: [pre(p)] };
            break;
          }
          walk(node);
          node.children = [
            tag(p.start.offset!, first.start.offset!),
            ...node.children,
            tag(last.end.offset!, p.end.offset!),
          ] as typeof node.children;
          break;
        }
        case "mdxJsxTextElement":
        case "mdxTextExpression":
          labels.set(key(p), INLINE);
          node.data = { hName: "code", hChildren: [text(p)] };
          break;
        default:
          if ("children" in node) walk(node);
      }
    }
  };
  walk(mdast);
  return labels;
}

/**
 * After sanitization: give each inert MDX block `class="rr-mdx"` and a generated (unpositioned)
 * `span.rr-mdx-label`; wrap each inline one in `span.rr-mdx-inline` with a short "MDX" label.
 */
export function labelMdx(tree: HastRoot, labels: Map<string, string>): void {
  if (!labels.size) return;
  const label = (value: string): Element => ({
    type: "element",
    tagName: "span",
    properties: { className: ["rr-mdx-label"] },
    children: [{ type: "text", value }],
  });
  const walk = (parent: HastRoot | Element) => {
    parent.children.forEach((el, i) => {
      if (el.type !== "element") return;
      const name = el.position && labels.get(key(el.position));
      if (name === INLINE && el.tagName === "code") {
        parent.children[i] = {
          type: "element",
          tagName: "span",
          properties: { className: ["rr-mdx-inline"] },
          children: [label(INLINE), el],
        };
        return;
      }
      if (name && name !== INLINE && el.tagName === "div") {
        el.properties.className = ["rr-mdx"];
        el.children.unshift(label(name));
      }
      walk(el);
    });
  };
  walk(tree);
}
