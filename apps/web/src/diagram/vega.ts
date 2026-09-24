// SPDX-License-Identifier: AGPL-3.0-only
// Vega and Vega-Lite charts, rendered in the sandboxed renderer frame (see ./vega-frame.ts). This
// module is imported only when a document has a `vega` or `vega-lite` fence.
import script from "./vega-frame?worker&url";
import { frameRenderer, rendererFrameSrc } from "./frame-client";

export const { load: loadVega } = frameRenderer({
  id: "vega",
  fenceNames: ["vega", "vega-lite"],
  // vega and vega-lite versions (their package.json files are not importable); bump with them.
  version: "6.4.0+6.4.3+1",
  label: "Vega",
  src: rendererFrameSrc(script),
});
