// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Vega and Vega-Lite as they render in the renderer frame: inline data only, expressions
// interpreted (no generated code), SVG out. One renderer serves both fences: a spec's `$schema`,
// else its shape, says which language it is.
import { expect, it } from "vitest";
import { sanitizeSvg } from "./sanitize";
import { renderVega } from "./vega-frame";

const BARS = JSON.stringify({
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  data: {
    values: [
      { a: "A", b: 28 },
      { a: "B", b: 55 },
    ],
  },
  mark: "bar",
  encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } },
  transform: [{ calculate: "datum.b * 2 + 1", as: "c" }],
});

const VEGA = JSON.stringify({
  width: 100,
  height: 50,
  data: [{ name: "t", values: [{ x: 1 }, { x: 2 }] }],
  scales: [{ name: "x", domain: { data: "t", field: "x" }, range: "width" }],
  marks: [
    {
      type: "rect",
      from: { data: "t" },
      encode: {
        enter: {
          x: { scale: "x", field: "x" },
          width: { value: 5 },
          y: { value: 0 },
          height: { signal: "height / 2" },
        },
      },
    },
  ],
});

it("renders Vega-Lite as SVG, evaluating expressions without generated code", async () => {
  const svg = await renderVega({ source: BARS, theme: "light" });
  expect(svg).toMatch(/^<svg/);
  expect(svg).toContain(">A</text>");
  expect(sanitizeSvg(svg)).toContain("<svg");
});

it("tells Vega from Vega-Lite by $schema, else by shape", async () => {
  const schema = JSON.stringify({ ...JSON.parse(VEGA), $schema: "https://vega.github.io/schema/vega/v6.json" });
  expect(await renderVega({ source: schema, theme: "light" })).toMatch(/^<svg/);
});

it("renders Vega specs", async () => {
  const svg = await renderVega({ source: VEGA, theme: "light" });
  expect(svg.match(/<path/g)?.length).toBeGreaterThanOrEqual(2);
});

it("labels axes in the theme's text colour, on a transparent background", async () => {
  const dark = await renderVega({ source: BARS, theme: "dark" });
  expect(dark).toContain("#f0f6fc");
  expect(dark).not.toMatch(/fill="(white|#fff|#ffffff)"/i);
});

it.each([
  ["a data URL", { data: { url: "https://evil.example/data.csv" }, mark: "point" }],
  ["a local file", { data: { url: "data/secret.json" }, mark: "point" }],
])("refuses to load %s", async (_, spec) => {
  await expect(renderVega({ source: JSON.stringify(spec), theme: "light" })).rejects.toThrow(/inline data only/);
});

it("refuses image marks' URLs", async () => {
  const spec = {
    data: { values: [{ u: "https://evil.example/x.png" }] },
    mark: { type: "image", width: 10, height: 10 },
    encoding: { url: { field: "u", type: "nominal" } },
  };
  await expect(renderVega({ source: JSON.stringify(spec), theme: "light" })).rejects.toThrow(/inline data only/);
});

it("rejects invalid JSON", async () => {
  await expect(renderVega({ source: "{", theme: "light" })).rejects.toThrow(/JSON/);
});

it.each([
  ["a Vega-Lite sequence", { data: { sequence: { start: 0, stop: 3e8 } }, mark: "point" }],
  [
    "a Vega sequence",
    { data: [{ name: "s", transform: [{ type: "sequence", start: 0, stop: 1e9, step: 1 }] }], marks: [] },
  ],
  [
    "a sequence sized by a signal",
    {
      signals: [{ name: "n", value: 1e9 }],
      data: [{ name: "s", transform: [{ type: "sequence", start: 0, stop: { signal: "n" } }] }],
      marks: [],
    },
  ],
])("refuses %s too long to generate", async (_, spec) => {
  await expect(renderVega({ source: JSON.stringify(spec), theme: "light" })).rejects.toThrow(/sequence/i);
});

it("generates short sequences", async () => {
  const spec = {
    data: { sequence: { start: 0, stop: 10, as: "x" } },
    mark: "point",
    encoding: { x: { field: "x", type: "quantitative" } },
  };
  await expect(renderVega({ source: JSON.stringify(spec), theme: "light" })).resolves.toMatch(/^<svg/);
});
