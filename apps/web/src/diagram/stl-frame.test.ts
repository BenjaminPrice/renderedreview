// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// ASCII STL models as they render in the renderer frame: a flat-shaded isometric view.
import { expect, it } from "vitest";
import { sanitizeSvg } from "./sanitize";
import { renderStl } from "./stl-frame";

const facet = (a: number[], b: number[], c: number[]) =>
  `  facet normal 0 0 0\n    outer loop\n${[a, b, c].map((v) => `      vertex ${v.join(" ")}\n`).join("")}    endloop\n  endfacet\n`;

// A tetrahedron, 10 units along each axis.
const TETRA = `solid tetra\n${[
  facet([0, 0, 0], [10, 0, 0], [0, 10, 0]),
  facet([0, 0, 0], [0, 0, 10], [10, 0, 0]),
  facet([0, 0, 0], [0, 10, 0], [0, 0, 10]),
  facet([10, 0, 0], [0, 0, 10], [0, 10, 0]),
].join("")}endsolid tetra\n`;

const polygons = (svg: string) => [...svg.matchAll(/<polygon [^>]*points="([^"]+)"/g)].map((m) => m[1]!);

it("draws one shaded polygon per triangle, inside the view box", async () => {
  const svg = await renderStl({ source: TETRA, theme: "light" });
  const [, , width, height] = /viewBox="([\d.\s]+)"/.exec(svg)![1]!.split(" ").map(Number);
  const shapes = polygons(svg);
  expect(shapes).toHaveLength(4);
  for (const points of shapes) {
    const coords = points.split(/[\s,]/).map(Number);
    expect(coords).toHaveLength(6);
    for (const [i, n] of coords.entries()) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(i % 2 ? height! : width!);
    }
  }
  // Faces facing different ways get different shades.
  const fills = new Set([...svg.matchAll(/<polygon [^>]*fill="([^"]+)"/g)].map((m) => m[1]));
  expect(fills.size).toBeGreaterThan(1);
  expect(sanitizeSvg(svg)).toContain("<polygon");
});

it("states the triangle count and size as text", async () => {
  const svg = await renderStl({ source: TETRA, theme: "light" });
  expect(svg).toContain("4 triangles · 10 × 10 × 10");
});

it("shades for the theme", async () => {
  const light = await renderStl({ source: TETRA, theme: "light" });
  const dark = await renderStl({ source: TETRA, theme: "dark" });
  expect(light).not.toBe(dark);
});

it.each([
  ["empty solid", "solid x\nendsolid x", /no triangles/],
  ["not ASCII STL", "hello", /Not an ASCII STL model/],
  [
    "a broken facet",
    `solid x\n${facet([0, 0, 0], [1, 0, 0], [0, 1, 0]).replace("vertex 0 1 0", "vertex 0 1")}endsolid`,
    /vertex/,
  ],
  [
    "non-numeric vertex",
    `solid x\n${facet([0, 0, 0], [1, 0, 0], [0, 1, 0]).replace("vertex 0 1 0", "vertex 0 1 NaN")}endsolid`,
    /vertex/,
  ],
])("rejects %s", async (_, source, message) => {
  await expect(renderStl({ source, theme: "light" })).rejects.toThrow(message);
});
