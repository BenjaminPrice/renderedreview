// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// GeoJSON and TopoJSON maps as they render in the renderer frame: vector outlines only, no tiles.
// One renderer serves both fences; a TopoJSON document says so in its `type`.
import { expect, it } from "vitest";
import { renderGeo } from "./geo-frame";
import { sanitizeSvg } from "./sanitize";

// Counter-clockwise exterior ring, as RFC 7946 requires.
const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};
const COLLECTION = JSON.stringify({
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "Park" }, geometry: SQUARE },
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [20, 5],
        ],
      },
    },
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [15, 8] } },
  ],
});

const paths = (svg: string) => [...svg.matchAll(/<path [^>]*d="([^"]+)"/g)].map((m) => m[1]!);

it("draws each feature as a path fitted to the frame, with no network references", async () => {
  const svg = await renderGeo({ source: COLLECTION, theme: "light" });
  expect(svg).toMatch(/^<svg[^>]* viewBox="0 0 \d+ \d+"/);
  expect(paths(svg)).toHaveLength(3);
  expect(svg).not.toMatch(/href|url\(|<image/);
  expect(sanitizeSvg(svg)).toContain("<path");
});

it("fills the polygon itself, not the rest of the world, whatever its winding", async () => {
  const svg = await renderGeo({ source: JSON.stringify(SQUARE), theme: "light" });
  const [d] = paths(svg);
  // One ring of four corners (plus close), inside the viewBox.
  expect(d).toMatch(/^M[\d.,]+(L[\d.,]+){3}Z$/);
  for (const n of d!.match(/[\d.]+/g)!.map(Number)) expect(n).toBeLessThanOrEqual(800);
});

it("colours outlines for the theme", async () => {
  const light = await renderGeo({ source: COLLECTION, theme: "light" });
  const dark = await renderGeo({ source: COLLECTION, theme: "dark" });
  expect(light).toContain("#0969da");
  expect(dark).toContain("#4493f8");
});

it("renders every object of a TopoJSON topology", async () => {
  const topology = {
    type: "Topology",
    arcs: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [0, 0],
        [20, 5],
      ],
    ],
    objects: {
      land: { type: "GeometryCollection", geometries: [{ type: "Polygon", arcs: [[0]] }] },
      roads: { type: "LineString", arcs: [1] },
    },
  };
  const svg = await renderGeo({ source: JSON.stringify(topology), theme: "light" });
  expect(paths(svg)).toHaveLength(2);
});

it.each([
  ["not json", /not valid JSON/],
  ['{"type":"Nope"}', /Not GeoJSON or TopoJSON/],
  ["[]", /Not GeoJSON or TopoJSON/],
  ['{"type":"Topology","objects":{"x":{"type":"Polygon","arcs":[[7]]}},"arcs":[]}', /missing arc 7/],
])("rejects %s", async (source, message) => {
  await expect(renderGeo({ source, theme: "light" })).rejects.toThrow(message);
});

it("refuses too many features", async () => {
  const features = Array.from({ length: 10_001 }, () => ({ type: "Feature", geometry: null }));
  await expect(
    renderGeo({ source: JSON.stringify({ type: "FeatureCollection", features }), theme: "light" }),
  ).rejects.toThrow(/too many features/);
});

it("refuses a topology whose arc references expand to too many points, before expanding them", async () => {
  // A tiny source: one long arc, referenced 20,000 times.
  const arc = Array.from({ length: 1000 }, (_, i) => [i, i % 2]);
  const topology = {
    type: "Topology",
    arcs: [arc],
    objects: { bomb: { type: "MultiLineString", arcs: Array.from({ length: 20_000 }, () => [0]) } },
  };
  await expect(renderGeo({ source: JSON.stringify(topology), theme: "light" })).rejects.toThrow(/too many points/);
});
