// SPDX-License-Identifier: AGPL-3.0-only
// The parts of WaveDrom (no type definitions of its own) that the renderer uses.
declare module "wavedrom" {
  type JsonML = [string, Record<string, unknown>, ...unknown[]];
  export function renderAny(index: number, source: object, skins: Record<string, unknown>): JsonML;
  export const onml: { stringify(tree: JsonML): string };
  export const version: string;
}
declare module "wavedrom/skins/*" {
  const skins: Record<string, unknown>;
  export default skins;
}
