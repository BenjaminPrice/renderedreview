// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The app's registry: which fences render, and that renderer modules load only on first use.
import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => [] as string[]);
const fake = (id: string) => ({ id, fenceNames: [], version: "1", render: vi.fn() });

vi.mock("./graphviz", () => {
  loaded.push("graphviz");
  return { loadGraphviz: async () => fake("graphviz") };
});

vi.mock("./wavedrom", () => {
  loaded.push("wavedrom");
  return { loadWaveDrom: async () => fake("wavedrom") };
});

vi.mock("./geo", () => {
  loaded.push("geo");
  return { loadGeo: async () => fake("geo") };
});

vi.mock("./stl", () => {
  loaded.push("stl");
  return { loadStl: async () => fake("stl") };
});

vi.mock("./vega", () => {
  loaded.push("vega");
  return { loadVega: async () => fake("vega") };
});

const { diagramRegistry } = await import("./registry");

it.each([
  [["dot", "graphviz", "DOT"], "Graphviz", "graphviz"],
  [["wavedrom"], "WaveDrom", "wavedrom"],
  [["geojson", "topojson"], "Map", "geo"],
  [["stl"], "STL", "stl"],
  [["vega", "vega-lite"], "Vega", "vega"],
])("renders %j fences with %s, loading it on first use", async (fences, label, id) => {
  const entry = diagramRegistry.match(fences[0])!;
  expect(entry.label).toBe(label);
  for (const fence of fences) expect(diagramRegistry.match(fence)).toBe(entry);
  expect(loaded).not.toContain(id);
  await expect(entry.load()).resolves.toMatchObject({ id });
  expect(loaded).toContain(id);
});
