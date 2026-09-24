// SPDX-License-Identifier: AGPL-3.0-only
// WaveDrom, run in the renderer frame's Worker (see ./wavedrom-frame.ts). This module is imported
// only when a document has a `wavedrom` fence.
import { version } from "wavedrom/package.json";
import script from "./wavedrom-frame?worker&url";
import { bundledHost, frameRenderer } from "./frame-client";

export const { load: loadWaveDrom } = frameRenderer({
  id: "wavedrom",
  fenceNames: ["wavedrom"],
  version: `${version}+1`,
  label: "WaveDrom",
  host: bundledHost(script),
});
