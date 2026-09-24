// SPDX-License-Identifier: AGPL-3.0-only
import type { Element, Root } from "hast";

// Normalized as the URL parser does: tab/newline dropped, leading C0 and spaces trimmed, `\` is `/`.
const isExternal = (href: string) =>
  /^(https?:|\/\/)/i.test(
    href
      .replace(/[\t\n\r]/g, "")
      .replace(/^[\0- ]+/, "")
      .replaceAll("\\", "/"),
  );

/**
 * External links (absolute http(s) or protocol-relative URLs) open in a new tab and send no referrer. Fragment links,
 * same-origin paths from a link resolver, mailto and unresolved relative links are left alone.
 * Runs after sanitization, which strips any authored `target` or `rel`.
 */
export function markExternalLinks(tree: Root): void {
  const visit = (el: Element) => {
    if (el.tagName === "a" && typeof el.properties.href === "string" && isExternal(el.properties.href)) {
      el.properties.target = "_blank";
      el.properties.rel = ["noopener", "noreferrer"];
    }
    for (const child of el.children) if (child.type === "element") visit(child);
  };
  for (const child of tree.children) if (child.type === "element") visit(child);
}
