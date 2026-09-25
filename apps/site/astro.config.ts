// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "astro/config";

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
});
