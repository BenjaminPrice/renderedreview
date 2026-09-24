// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// WaveDrom as it runs in the renderer frame.
import { expect, it } from "vitest";
import { sanitizeSvg } from "./sanitize";
import { renderWaveDrom } from "./wavedrom-frame";

const CLOCK = `{ signal: [ // JSON5: comments, unquoted keys, trailing commas
  { name: 'clk', wave: 'p.....' },
  { name: 'data', wave: 'x.34.x', data: ['head', 'tail'], },
]}`;

it("renders a JSON5 timing diagram as SVG", async () => {
  const svg = await renderWaveDrom({ source: CLOCK, theme: "light" });
  expect(svg).toMatch(/^<svg/);
  expect(svg).toContain("clk");
  expect(svg).toContain("head");
  expect(sanitizeSvg(svg)).toContain("<svg");
});

it("uses the dark skin in the dark theme unless the author chose one", async () => {
  const light = await renderWaveDrom({ source: CLOCK, theme: "light" });
  const dark = await renderWaveDrom({ source: CLOCK, theme: "dark" });
  expect(light).not.toContain("fill:#ffffff");
  expect(dark).toContain("fill:#ffffff");
  // WaveDrom paints a white background whatever the skin; the page shows through instead.
  expect(dark).not.toContain("fill:white");
  const chosen = await renderWaveDrom({ source: "{ signal: [{ wave: 'p.' }], config: { skin: 'narrow' } }", theme: "dark" });
  expect(chosen).not.toContain("fill:#ffffff");
});

it("renders register (bit field) diagrams", async () => {
  const svg = await renderWaveDrom({ source: "{ reg: [{ bits: 8, name: 'OP' }, { bits: 8 }] }", theme: "light" });
  expect(svg).toContain("OP");
});

it.each([
  ["code instead of data", "{ signal: [{ wave: (() => 'p')() }] }", /JSON5/],
  ["not a diagram", "[1, 2]", /Not a WaveDrom diagram/],
  ["no known diagram kind", "{ foo: 1 }", /Not a WaveDrom diagram/],
])("rejects %s", async (_, source, message) => {
  await expect(renderWaveDrom({ source, theme: "light" })).rejects.toThrow(message);
});
