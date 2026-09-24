// SPDX-License-Identifier: AGPL-3.0-only
// The diagram formats this app renders. Each renderer module is imported the first time a
// document shows one of its fences; documents without diagrams never load renderer code.
import { createDiagramRegistry } from "@rendered-review/diagram-domain";
import { createContext } from "react";

// Diagrams render in the browser only. Each `load` checks `import.meta.env.SSR` before its dynamic
// import so the import is dropped from server bundles: renderer code (megabytes, for some) never
// reaches the Worker upload.
const SERVER = () => Promise.reject(new Error("Diagrams render in the browser"));

export const diagramRegistry = createDiagramRegistry([
  {
    label: "Mermaid",
    fenceNames: ["mermaid"],
    load: () => (import.meta.env.SSR ? SERVER() : import("./mermaid").then((m) => m.loadMermaid())),
  },
  {
    label: "Graphviz",
    fenceNames: ["dot", "graphviz"],
    load: () => (import.meta.env.SSR ? SERVER() : import("./graphviz").then((m) => m.loadGraphviz())),
  },
  {
    label: "WaveDrom",
    fenceNames: ["wavedrom"],
    load: () => (import.meta.env.SSR ? SERVER() : import("./wavedrom").then((m) => m.loadWaveDrom())),
  },
  {
    label: "Map",
    fenceNames: ["geojson", "topojson"],
    load: () => (import.meta.env.SSR ? SERVER() : import("./geo").then((m) => m.loadGeo())),
  },
  {
    label: "STL model",
    fenceNames: ["stl"],
    load: () => (import.meta.env.SSR ? SERVER() : import("./stl").then((m) => m.loadStl())),
  },
  {
    label: "Vega",
    fenceNames: ["vega", "vega-lite"],
    load: () => (import.meta.env.SSR ? SERVER() : import("./vega").then((m) => m.loadVega())),
  },
]);

/** Tests substitute fake renderers here. */
export const DiagramRegistryContext = createContext(diagramRegistry);
