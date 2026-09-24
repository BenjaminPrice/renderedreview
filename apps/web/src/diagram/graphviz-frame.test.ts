// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Graphviz as it runs in the renderer frame, with the real WebAssembly build.
import { expect, it } from "vitest";
import { renderDot } from "./graphviz-frame";
import { sanitizeSvg } from "./sanitize";

it("lays out DOT as SVG with a transparent background", async () => {
  const svg = await renderDot({ source: 'digraph G { label="Build"; a -> b }', theme: "light" });
  expect(svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  expect(svg).toContain(">a</text>");
  expect(svg).toContain(">Build</text>");
  expect(svg).not.toContain('fill="white"');
});

it("draws default strokes and text in the dark theme's colours", async () => {
  const svg = await renderDot({ source: "graph { a -- b; c [color=red] }", theme: "dark" });
  expect(svg).not.toMatch(/="black"/);
  expect(svg).toContain('stroke="#f0f6fc"');
  expect(svg).toMatch(/<svg[^>]* fill="#f0f6fc"/);
  expect(svg).toContain('stroke="red"');
});

it("rejects invalid DOT with Graphviz's message", async () => {
  await expect(renderDot({ source: "digraph { a -> }", theme: "light" })).rejects.toThrow(/syntax error/i);
});

it("reads no files or URLs, and its links and images do not survive sanitizing", async () => {
  const svg = await renderDot({
    source: `digraph {
      a [href="javascript:alert(1)", URL="https://evil.example/", image="https://evil.example/x.png"];
      b [label=<<img src="https://evil.example/y.png"/>>];
      a -> b [href="https://evil.example/edge"];
    }`,
    theme: "light",
  });
  expect(svg).toContain(">a</text>");
  const clean = sanitizeSvg(svg);
  expect(clean).not.toContain("evil.example");
  expect(clean).not.toContain("javascript:");
});
