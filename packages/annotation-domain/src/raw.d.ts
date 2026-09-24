// SPDX-License-Identifier: AGPL-3.0-only
// Vite `?raw` imports of Markdown fixtures in tests.
declare module "*.md?raw" {
  const source: string;
  export default source;
}
declare module "*.mdx?raw" {
  const source: string;
  export default source;
}
