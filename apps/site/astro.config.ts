// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { rehypeDocLinks } from "./src/docs-links";
import { publishedDocs } from "./src/docs-nav";

export default defineConfig({
  site: "https://renderedreview.com",
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
    // Every style and script is a same-origin file, so the CSP needs no inline allowances.
    inlineStylesheets: "never",
  },
  vite: { build: { assetsInlineLimit: 0 } },
  markdown: {
    // Highlighting would add inline style attributes, which the CSP forbids.
    syntaxHighlight: false,
    rehypePlugins: [
      [rehypeDocLinks, { repoRoot: fileURLToPath(new URL("../..", import.meta.url)), published: publishedDocs }],
    ],
  },
});
