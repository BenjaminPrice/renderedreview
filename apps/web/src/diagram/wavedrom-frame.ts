// SPDX-License-Identifier: AGPL-3.0-only
// WaveDrom timing and register diagrams, run in the renderer frame. The source is parsed as JSON5
// data (never evaluated as script, unlike WaveDrom's own page loader).
import JSON5 from "json5";
import { onml, renderAny } from "wavedrom";
import dark from "wavedrom/skins/dark.js";
import light from "wavedrom/skins/default.js";
import { serveRenderer, type FrameRender } from "./frame-entry";

// ponytail: only the default and dark skins are bundled; an author's other skin falls back to default.
const SKINS = { ...light, ...dark };

export const renderWaveDrom: FrameRender = async ({ source, theme }) => {
  const diagram: unknown = JSON5.parse(source);
  if (!isDiagram(diagram)) throw new Error("Not a WaveDrom diagram: expected an object with signal, reg or assign");
  const config = (diagram.config ?? {}) as { skin?: unknown };
  if (theme === "dark" && config.skin === undefined) diagram.config = { ...config, skin: "dark" };
  // WaveDrom paints a white background whatever the skin; the page shows through instead.
  return onml.stringify(renderAny(0, diagram, SKINS)).replace('style="stroke:none;fill:white"', 'style="stroke:none;fill:none"');
};

const isDiagram = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  ["signal", "reg", "assign"].some((kind) => Array.isArray((value as Record<string, unknown>)[kind]));

serveRenderer(async () => renderWaveDrom);
