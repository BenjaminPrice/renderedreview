// SPDX-License-Identifier: AGPL-3.0-only
// Vega and Vega-Lite, run in the renderer frame. Specs may use inline data only: the loader refuses
// every URL and file, so nothing is fetched (the frame's policy would block it anyway). Expressions
// run in Vega's interpreter rather than as generated code, and the view renders headless to SVG.
import type { DiagramTheme } from "@rendered-review/diagram-domain";
import { logger, parse, transforms, View, type Config, type Loader, type Spec } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile, type TopLevelSpec } from "vega-lite";
import { serveRenderer, type FrameRender } from "./frame-entry";
import { PALETTE } from "./palette";

// A `sequence` generates rows from three numbers, so a one-line spec could exhaust memory.
// ponytail: only `sequence` is capped; other generators (density steps, contour sizes) rely on
// the render timeout and the frame being discarded.
const MAX_SEQUENCE = 100_000;
type TransformClass = {
  new (params: unknown): object;
  Definition: unknown;
  prototype: { transform: (this: object, ...args: unknown[]) => unknown };
};
const Sequence = transforms.sequence as unknown as TransformClass;
function LimitedSequence(this: object, params: unknown) {
  Sequence.call(this, params);
}
LimitedSequence.Definition = Sequence.Definition;
LimitedSequence.prototype = Object.create(Sequence.prototype, {
  constructor: { value: LimitedSequence },
  transform: {
    value(this: object, _: { start: number; stop: number; step?: number }, pulse: unknown) {
      const rows = (_.stop - _.start) / (_.step || 1);
      if (!(rows <= MAX_SEQUENCE)) throw new Error(`A sequence may have at most ${MAX_SEQUENCE} rows`);
      return Sequence.prototype.transform.call(this, _, pulse);
    },
  },
});
(transforms as Record<string, unknown>).sequence = LimitedSequence;

// Vega-Lite's composition keys; a spec with none of them (and no $schema) is Vega.
const LITE_KEYS = ["mark", "layer", "facet", "repeat", "concat", "hconcat", "vconcat", "spec"];

function config(theme: DiagramTheme): Config {
  const { text, muted, line } = PALETTE[theme];
  return {
    background: "transparent",
    title: { color: text, subtitleColor: muted },
    axis: { labelColor: text, titleColor: text, domainColor: line, tickColor: line, gridColor: line },
    legend: { labelColor: text, titleColor: text },
    view: { stroke: line },
    style: { "guide-label": { fill: text }, "guide-title": { fill: text }, "group-title": { fill: text } },
  } as Config;
}

export const renderVega: FrameRender = async ({ source, theme }) => {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(source) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`The chart is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) throw new Error("Not a Vega or Vega-Lite spec");
  const schema = typeof spec.$schema === "string" ? spec.$schema : "";
  const lite = schema ? schema.includes("vega-lite") : LITE_KEYS.some((key) => key in spec);
  const themed = config(theme);
  const vegaSpec = lite ? compile(spec as unknown as TopLevelSpec, { config: themed as never }).spec : (spec as Spec);
  // Vega logs dataflow errors (a bad expression) and refused loads and renders on; they fail the render.
  const errors: unknown[] = [];
  const refuse = () => {
    const error = new Error("Charts may use inline data only");
    errors.push(error);
    return Promise.reject(error);
  };
  const loader = { load: refuse, sanitize: refuse, http: refuse, file: refuse } as unknown as Loader;
  const log = logger();
  log.error = (...args: readonly unknown[]) => (errors.push(args[0]), log);
  const view = new View(parse(vegaSpec, themed, { ast: true }), {
    expr: expressionInterpreter,
    loader,
    logger: log,
    renderer: "none",
  });
  try {
    const svg = await view.toSVG();
    if (errors.length) throw errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
    return svg;
  } finally {
    view.finalize();
  }
};

serveRenderer(async () => renderVega);
