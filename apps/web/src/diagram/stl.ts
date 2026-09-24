// SPDX-License-Identifier: AGPL-3.0-only
// ASCII STL models, drawn in the sandboxed renderer frame (see ./stl-frame.ts). This module is
// imported only when a document has an `stl` fence.
import script from "./stl-frame?worker&url";
import { frameRenderer, rendererFrameSrc } from "./frame-client";

export const { load: loadStl } = frameRenderer({
  id: "stl",
  fenceNames: ["stl"],
  version: "1",
  label: "STL model",
  src: rendererFrameSrc(script),
});
