// SPDX-License-Identifier: AGPL-3.0-only
// Graphviz DOT, run in the renderer frame's Worker (see ./graphviz-frame.ts). This module is
// imported only when a document has a `dot` or `graphviz` fence.
import script from "./graphviz-frame?worker&url";
import { bundledHost, frameRenderer } from "./frame-client";

export const { load: loadGraphviz } = frameRenderer({
  id: "graphviz",
  fenceNames: ["dot", "graphviz"],
  // @hpcc-js/wasm-graphviz's version (its package.json is not importable); bump with it.
  version: "1.29.1+1",
  label: "Graphviz",
  host: bundledHost(script),
});
