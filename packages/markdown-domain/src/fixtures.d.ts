// SPDX-License-Identifier: AGPL-3.0-only
declare module "*.md?raw" {
  const source: string;
  export default source;
}
declare module "*.mdx?raw" {
  const source: string;
  export default source;
}
