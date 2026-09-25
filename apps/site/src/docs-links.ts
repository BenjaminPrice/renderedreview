// SPDX-License-Identifier: AGPL-3.0-only
// Links in the repository's docs/*.md, published on the site: links to other published docs go to
// their /docs/ page; other repository paths go to GitHub; links off the site open in a new tab.
import { posix, relative } from "node:path";
import { REPO_URL } from "./site";

/** `href` as written in the Markdown file at repository path `from` (e.g. "docs/observability.md"). */
export function rewriteDocHref(href: string, from: string, published: ReadonlySet<string>) {
  if (href.startsWith("#")) return { href, external: false };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { href, external: true };
  const [path = "", hash = ""] = href.split(/(?=#)/);
  const target = posix.normalize(posix.join(posix.dirname(from), path));
  const doc = /^docs\/([^/]+)\.md$/.exec(target)?.[1];
  if (doc && published.has(doc)) return { href: `/docs/${doc}/${hash}`, external: false };
  return { href: `${REPO_URL}/blob/main/${target}${hash}`, external: true };
}

interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  value?: string;
}

/** Rehype plugin applying rewriteDocHref to every link in Markdown under `repoRoot`. */
export function rehypeDocLinks({ repoRoot, published }: { repoRoot: string; published: ReadonlySet<string> }) {
  return (tree: Node, file: { path?: string }) => {
    if (!file.path) return;
    const from = relative(repoRoot, file.path).split("\\").join("/");
    const walk = (node: Node) => {
      if (node.tagName === "a" && typeof node.properties?.href === "string") {
        const { href, external } = rewriteDocHref(node.properties.href, from, published);
        node.properties.href = href;
        if (external) {
          node.properties.target = "_blank";
          node.properties.rel = ["noopener", "noreferrer"];
          node.children = [
            ...(node.children ?? []),
            {
              type: "element",
              tagName: "span",
              properties: { className: ["sr-only"] },
              children: [{ type: "text", value: " (opens in new tab)" }],
            },
          ];
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
