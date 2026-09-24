// SPDX-License-Identifier: AGPL-3.0-only
// GeoJSON and TopoJSON maps, run in the renderer frame: plain vector outlines fitted to the frame,
// with no basemap or tiles, so nothing is fetched. Coordinates are drawn as a flat
// longitude/latitude plane, which also keeps polygons of either winding order the right way out.
import type { DiagramTheme } from "@rendered-review/diagram-domain";
import { geoIdentity, geoPath } from "d3-geo";
import type { GeoJSON } from "geojson";
import { feature } from "topojson-client";
import { serveRenderer, type FrameRender } from "./frame-entry";
import { PALETTE } from "./palette";

type Topology = Parameters<typeof feature>[0];

const WIDTH = 800;
const HEIGHT = 500;
const MAX_FEATURES = 10_000;
// Checked on TopoJSON before arcs are expanded: a small topology can reference one long arc many times.
const MAX_POINTS = 200_000;

const GEOJSON_TYPES = new Set([
  "FeatureCollection",
  "Feature",
  "GeometryCollection",
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

export const renderGeo: FrameRender = async ({ source, theme }) => {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new Error(`The map is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  const type = (data as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || Array.isArray(data)) throw new Error("Not GeoJSON or TopoJSON: no `type`");
  if (type === "Topology") return draw(fromTopology(data as Topology), theme);
  if (!GEOJSON_TYPES.has(type)) throw new Error(`Not GeoJSON or TopoJSON: unknown type ${type}`);
  return draw(data as GeoJSON, theme);
};

function fromTopology(topology: Topology): GeoJSON {
  const arcs = Array.isArray(topology.arcs) ? topology.arcs : [];
  let points = 0;
  // Arc indexes nest to any depth; a negative index `~i` is arc i reversed.
  const count = (refs: unknown): void => {
    if (typeof refs === "number") {
      const arc = arcs[refs < 0 ? ~refs : refs];
      if (!arc) throw new Error(`Not valid TopoJSON: missing arc ${refs}`);
      points += arc.length;
      if (points > MAX_POINTS) throw new Error(`The map has too many points (the limit is ${MAX_POINTS})`);
    } else if (Array.isArray(refs)) refs.forEach(count);
  };
  const geometries = (object: unknown): void => {
    const o = object as { arcs?: unknown; geometries?: unknown[] };
    count(o.arcs);
    o.geometries?.forEach(geometries);
  };
  const objects = Object.values(topology.objects ?? {}) as Parameters<typeof feature>[1][];
  objects.forEach(geometries);
  return {
    type: "FeatureCollection",
    features: objects.flatMap((object) => {
      const result = feature(topology, object);
      return "features" in result ? result.features : [result];
    }),
  };
}

function draw(geo: GeoJSON, theme: DiagramTheme): string {
  const features =
    geo.type === "FeatureCollection" ? geo.features : geo.type === "GeometryCollection" ? geo.geometries : [geo];
  if (!Array.isArray(features)) throw new Error("Not valid GeoJSON: expected a list of features");
  if (features.length > MAX_FEATURES) {
    throw new Error(`The map has too many features (${features.length}; the limit is ${MAX_FEATURES})`);
  }
  const projection = geoIdentity().reflectY(true).fitExtent(
    [
      [10, 10],
      [WIDTH - 10, HEIGHT - 10],
    ],
    geo,
  );
  const path = geoPath(projection).digits(1).pointRadius(4);
  const { accent } = PALETTE[theme];
  const shapes = features
    .map((f) => {
      const d = path(f);
      if (!d) return "";
      const geometry = "geometry" in f ? f.geometry : f;
      const line = /LineString/.test(geometry?.type ?? "");
      return `<path d="${d}" fill="${line ? "none" : accent}" fill-opacity="0.2" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">${shapes}</svg>`;
}

serveRenderer(async () => renderGeo);
