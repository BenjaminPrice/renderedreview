// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// jsdom, not happy-dom: DOMPurify cannot read element names in happy-dom and strips everything.
import { expect, it } from "vitest";
import { sanitizeSvg } from "./sanitize";

const parse = (svg: string) => new DOMParser().parseFromString(svg, "image/svg+xml");

const MALICIOUS = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" onload="alert(1)">
  <script>alert(2)</script>
  <style>@import url(https://evil.example/x.css); .node { fill: url(https://evil.example/p.svg#a); stroke: url(#grad) }</style>
  <a xlink:href="javascript:alert(3)"><text>click</text></a>
  <a href="https://evil.example/"><text>out</text></a>
  <image href="https://evil.example/pixel.png" width="1" height="1"/>
  <use href="#local"/>
  <g id="local" onclick="alert(4)"><rect width="10" height="10" style="fill: red"/></g>
  <foreignObject width="100" height="20"><div xmlns="http://www.w3.org/1999/xhtml">label<br/><img src="x" onerror="alert(5)"/><iframe src="https://evil.example"></iframe></div></foreignObject>
  <animate attributeName="href" to="javascript:alert(6)"/>
</svg>`;

it("removes scripts, handlers, external references and active HTML", () => {
  const out = sanitizeSvg(MALICIOUS);
  expect(out).not.toMatch(/<script|onload|onclick|onerror|javascript:|evil\.example|<iframe|<img|<animate|@import/i);
  const doc = parse(out);
  expect(doc.querySelector("parsererror")).toBeNull();
  expect(doc.querySelector("text")?.textContent).toBe("click");
  // Same-document references and styling survive.
  expect(doc.querySelector("use")?.getAttribute("href")).toBe("#local");
  expect(doc.querySelector("style")?.textContent).toContain("url(#grad)");
  expect(doc.querySelector("rect")?.getAttribute("style")).toContain("fill: red");
});

it("keeps plain HTML labels in foreignObject as well-formed XML", () => {
  const out = sanitizeSvg(MALICIOUS);
  const div = parse(out).querySelector("foreignObject div");
  expect(div?.textContent).toBe("label");
});

it("sizes the SVG from its viewBox so it has intrinsic dimensions as an image", () => {
  const out = sanitizeSvg('<svg viewBox="0 0 734.5 200" width="100%" style="max-width: 734.5px"><g/></svg>');
  const svg = parse(out).documentElement;
  expect(svg.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
  expect(svg.getAttribute("width")).toBe("734.5");
  expect(svg.getAttribute("height")).toBe("200");
  expect(svg.getAttribute("style") ?? "").not.toContain("max-width");
});

it("rejects input without an SVG root", () => {
  expect(() => sanitizeSvg("<div>not svg</div>")).toThrow("Renderer produced no SVG");
});
