// SPDX-License-Identifier: AGPL-3.0-only
// Mermaid, run in the sandboxed renderer frame (see ./frame.ts). This module is imported only
// when a document has a `mermaid` fence. The frame loads Mermaid's self-contained browser build,
// which the page itself never executes.
import scriptUrl from "mermaid/dist/mermaid.min.js?url";
import { version } from "mermaid/package.json";
import { frameHost, frameRenderer } from "./frame-client";

const mermaid = frameRenderer({
  id: "mermaid",
  fenceNames: ["mermaid"],
  // The suffix covers this adapter's own output changes (frame config, sanitizing).
  version: `${version}+1`,
  label: "Mermaid",
  // Served by routes/frames.mermaid.ts.
  host: frameHost(`/frames/mermaid?script=${encodeURIComponent(scriptUrl)}`),
});

export const mermaidRenderer = mermaid.renderer;
export const loadMermaid = mermaid.load;
export const closeMermaidFrame = mermaid.close;
