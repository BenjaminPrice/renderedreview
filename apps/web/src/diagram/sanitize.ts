// SPDX-License-Identifier: AGPL-3.0-only
// Sanitizes renderer SVG before it reaches the page. The page then shows it as an <img>, where
// scripts never run and nothing loads; this is the second line of defence, not the only one.
import DOMPurify from "dompurify";

// Anything that is not a same-document `#fragment` reference could reach the network.
const EXTERNAL_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
const IMPORT = /@import[^;]*;?/gi;
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

let purify: ReturnType<typeof DOMPurify> | undefined;

function purifier() {
  if (purify) return purify;
  purify = DOMPurify(window);
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
  // Stylesheets never enter a DOM here: browsers check even inert parsed documents against the
  // page's CSP and report every <style>. They are scrubbed as text and put back as escaped XML.
  const css: string[] = [];
  const markup = svg.replace(STYLE, (_, text: string) => {
    css.push(decodeText(text).replace(IMPORT, "").replace(EXTERNAL_URL, "none"));
    return "";
  });
  const fragment = purifier().sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    // Mermaid draws HTML labels in foreignObject and reuses shapes with <use>; hrefs stay `#local`.
    ADD_TAGS: ["foreignObject", "use"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ["style", "img", "image", "iframe", "animate", "animateMotion", "animateTransform", "set", "a"],
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
  if (!css.length) return new XMLSerializer().serializeToString(root);
  // An unguessable placeholder marks where the stylesheet goes.
  const marker = `rr-style-${crypto.randomUUID()}`;
  root.prepend(root.ownerDocument.createComment(marker));
  return new XMLSerializer()
    .serializeToString(root)
    .replace(`<!--${marker}-->`, () => `<style>${escapeXml(css.join("\n"))}</style>`);
}

// Text as the HTML serializer writes it (in SVG, style text is ordinary escaped text).
const decodeText = (text: string) =>
  text.replace(/&(lt|gt|nbsp|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", nbsp: "\u00a0", amp: "&" })[e]!);

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
