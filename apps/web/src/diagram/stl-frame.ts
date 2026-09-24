// SPDX-License-Identifier: AGPL-3.0-only
// ASCII STL models, run in the renderer frame: an isometric, flat-shaded view drawn as SVG
// polygons (painter's algorithm), with the triangle count and size stated as text. Binary STL
// cannot be written in a Markdown fence. The source input limit bounds the model to about a
// thousand triangles, which this draws without WebGL or a 3D library.
import type { DiagramTheme } from "@rendered-review/diagram-domain";
import { serveRenderer, type FrameRender } from "./frame-entry";
import { PALETTE } from "./palette";

type Vec = [number, number, number];

const WIDTH = 600;
const HEIGHT = 450;
const CAPTION = 24;
const PAD = 12;

// Isometric camera, Z up: turned 45° about Z and looking down by atan(1/√2).
const YAW = Math.PI / 4;
const PITCH = Math.atan(Math.SQRT1_2);
// Light from the viewer's upper left, in view coordinates (right, up, towards the viewer).
const LIGHT = normalize([-0.3, 0.5, 1]);

export const renderStl: FrameRender = async ({ source, theme }) => draw(parse(source), theme);

function parse(source: string): Vec[][] {
  if (!/^\s*solid\b/.test(source)) throw new Error("Not an ASCII STL model: it must start with `solid`");
  const vertices: Vec[] = [];
  for (const line of source.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== "vertex") continue;
    const v = words.slice(1).map(Number);
    if (v.length !== 3 || !v.every(Number.isFinite)) throw new Error(`Bad vertex: ${line.trim()}`);
    vertices.push(v as Vec);
  }
  if (vertices.length % 3) throw new Error("A facet does not have three vertices");
  if (!vertices.length) throw new Error("The model has no triangles");
  const triangles: Vec[][] = [];
  for (let i = 0; i < vertices.length; i += 3) triangles.push(vertices.slice(i, i + 3));
  return triangles;
}

function draw(triangles: Vec[][], theme: DiagramTheme): string {
  const all = triangles.flat();
  const min = [0, 1, 2].map((i) => Math.min(...all.map((v) => v[i]!))) as Vec;
  const max = [0, 1, 2].map((i) => Math.max(...all.map((v) => v[i]!))) as Vec;
  const center = min.map((m, i) => (m + max[i]!) / 2) as Vec;

  const view = (p: Vec): Vec => {
    const [x, y, z] = sub(p, center);
    const x1 = x * Math.cos(YAW) - y * Math.sin(YAW);
    const y1 = x * Math.sin(YAW) + y * Math.cos(YAW);
    // Right, up, and towards the viewer.
    return [x1, y1 * Math.sin(PITCH) + z * Math.cos(PITCH), -(y1 * Math.cos(PITCH) - z * Math.sin(PITCH))];
  };
  const faces = triangles.map((t) => {
    const v = t.map(view);
    const normal = normalize(cross(sub(v[1]!, v[0]!), sub(v[2]!, v[0]!)));
    return { v, depth: (v[0]![2] + v[1]![2] + v[2]![2]) / 3, light: Math.abs(dot(normal, LIGHT)) };
  });
  faces.sort((a, b) => a.depth - b.depth); // farthest first

  const xs = faces.flatMap((f) => f.v.map((p) => p[0]));
  const ys = faces.flatMap((f) => f.v.map((p) => p[1]));
  const left = Math.min(...xs);
  const top = Math.max(...ys);
  const scale = Math.min(
    (WIDTH - 2 * PAD) / (Math.max(...xs) - left || 1),
    (HEIGHT - CAPTION - 2 * PAD) / (top - Math.min(...ys) || 1),
  );
  const base = rgb(PALETTE[theme].accent);
  const polygons = faces
    .map(({ v, light }) => {
      const points = v.map((p) => `${round(PAD + (p[0] - left) * scale)},${round(PAD + (top - p[1]) * scale)}`);
      const shade = `rgb(${base.map((c) => Math.round(c * (0.35 + 0.65 * (Number.isNaN(light) ? 0 : light)))).join(",")})`;
      return `<polygon points="${points.join(" ")}" fill="${shade}" stroke="${shade}" stroke-width="0.5" stroke-linejoin="round"/>`;
    })
    .join("");
  const size = max.map((m, i) => round(m - min[i]!)).join(" × ");
  const count = `${triangles.length} triangle${triangles.length === 1 ? "" : "s"}`;
  const caption = `<text x="${PAD}" y="${HEIGHT - 8}" font-family="sans-serif" font-size="13" fill="${PALETTE[theme].muted}">${count} · ${size}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">${polygons}${caption}</svg>`;
}

const round = (n: number) => Math.round(n * 100) / 100;
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(v: Vec): Vec {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

serveRenderer(async () => renderStl);
