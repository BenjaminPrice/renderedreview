// SPDX-License-Identifier: AGPL-3.0-only
// WaveDrom, run in the sandboxed renderer frame (see ./wavedrom-frame.ts). This module is imported
// only when a document has a `wavedrom` fence.
import { version } from "wavedrom/package.json";
import script from "./wavedrom-frame?worker&url";
import { frameRenderer, rendererFrameSrc } from "./frame-client";

export const { load: loadWaveDrom } = frameRenderer({
  id: "wavedrom",
  fenceNames: ["wavedrom"],
  version: `${version}+1`,
  label: "WaveDrom",
  src: rendererFrameSrc(script),
});
