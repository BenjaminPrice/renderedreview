// SPDX-License-Identifier: AGPL-3.0-only
// Sanitizes renderer SVG before it reaches the page. The page then shows it as an <img>, where
// scripts never run and nothing loads; this is the second line of defence, not the only one.
import DOMPurify from "dompurify";

// Anything that is not a same-document `#fragment` reference could reach the network.
const EXTERNAL_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
const IMPORT = /@import[^;]*;?/gi;

let purify: ReturnType<typeof DOMPurify> | undefined;

function purifier() {
  if (purify) return purify;
  purify = DOMPurify(window);
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style")
      node.textContent = (node.textContent ?? "").replace(IMPORT, "").replace(EXTERNAL_URL, "none");
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    // Parsed as HTML these are plain attributes; the XML serializer declares namespaces itself.
    for (const { name } of [...node.attributes]) if (name.startsWith("xmlns")) node.removeAttribute(name);
    for (const name of ["href", "xlink:href"]) {
      if (node.hasAttribute(name) && !node.getAttribute(name)!.startsWith("#")) node.removeAttribute(name);
    }
    const style = node.getAttribute("style");
    if (style) node.setAttribute("style", style.replace(EXTERNAL_URL, "none"));
  });
  return purify;
}

/**
 * Sanitized SVG as well-formed XML (so it can be shown as an `image/svg+xml` image), sized from its
 * viewBox. Keeps SVG, filters, same-document references and plain HTML labels inside
 * `foreignObject`; drops scripts, event handlers, animation, embedded images and frames, and every
 * external URL.
 */
export function sanitizeSvg(svg: string): string {
  const fragment = purifier().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    // Mermaid draws HTML labels in foreignObject and reuses shapes with <use>; hrefs stay `#local`.
    ADD_TAGS: ["foreignObject", "use"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ["img", "image", "iframe", "animate", "animateMotion", "animateTransform", "set", "a"],
    // Links are dropped, their text kept: a rendered diagram is a picture, not a navigation surface.
    KEEP_CONTENT: true,
    RETURN_DOM_FRAGMENT: true,
  });
  const root = fragment.firstElementChild;
  if (root?.localName !== "svg") throw new Error("Renderer produced no SVG");
  const box = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4 && box.every(Number.isFinite)) {
    root.setAttribute("width", String(box[2]));
    root.setAttribute("height", String(box[3]));
  }
  const style = root
    .getAttribute("style")
    ?.replace(/max-width\s*:[^;]*;?/i, "")
    .trim();
  if (style) root.setAttribute("style", style);
  else root.removeAttribute("style");
  return new XMLSerializer().serializeToString(root);
}
