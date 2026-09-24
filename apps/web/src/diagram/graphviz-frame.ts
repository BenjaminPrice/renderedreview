// SPDX-License-Identifier: AGPL-3.0-only
// Graphviz (WebAssembly build, WebAssembly inlined), run in the renderer frame. It is given no
// files or images, so `image` attributes and `<img>` labels cannot load anything.
import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { serveRenderer, type FrameRender } from "./frame-entry";
import { PALETTE } from "./palette";

let graphviz: Promise<Graphviz> | undefined;

export const renderDot: FrameRender = async ({ source, theme }) => {
  const output = (await (graphviz ??= Graphviz.load())).dot(source);
  // Without Graphviz's XML prologue and doctype; the page shows through the default white canvas.
  const svg = output.slice(output.indexOf("<svg")).replace(/(<polygon fill=)"white"/, '$1"none"');
  if (theme === "light") return svg;
  // Default black lines and text take the theme's text colour (text without a colour inherits it).
  const { text } = PALETTE.dark;
  return svg.replace(/="black"/g, `="${text}"`).replace(/<svg\b/, `<svg fill="${text}"`);
};

serveRenderer(async () => {
  await (graphviz ??= Graphviz.load());
  return renderDot;
});
