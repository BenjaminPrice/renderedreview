// SPDX-License-Identifier: AGPL-3.0-only
// GeoJSON and TopoJSON maps, drawn in the renderer frame's Worker (see ./geo-frame.ts). This
// module is imported only when a document has a `geojson` or `topojson` fence.
import script from "./geo-frame?worker&url";
import { bundledHost, frameRenderer } from "./frame-client";

export const { load: loadGeo } = frameRenderer({
  id: "geo",
  fenceNames: ["geojson", "topojson"],
  version: "1",
  label: "Map",
  host: bundledHost(script),
});
