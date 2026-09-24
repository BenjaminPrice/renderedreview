// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";

// Builds src/sw/sw.ts into /sw.js with the client build's file list inlined. Start allows
// only one client entry, so the worker is a separate nested build. Its version is a hash
// of the (content-hashed) file names: a deploy that changes any asset changes sw.js,
// which makes browsers install the new worker and drop the old cache.
function serviceWorker(): Plugin {
  return {
    name: "rendered-review:service-worker",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    async generateBundle(_, bundle) {
      const base = this.environment.config.base;
      const urls = Object.keys(bundle)
        .filter((file) => !file.endsWith(".map"))
        .sort()
        .map((file) => base + file);
      const version = createHash("sha256").update(urls.join("\n")).digest("hex").slice(0, 16);
      const output = await build({
        configFile: false,
        publicDir: false,
        logLevel: "warn",
        define: { __SW_MANIFEST__: JSON.stringify({ version, urls }) },
        build: {
          write: false,
          rollupOptions: {
            input: fileURLToPath(new URL("src/sw/sw.ts", import.meta.url)),
            output: { format: "iife", entryFileNames: "sw.js" },
          },
        },
      });
      const chunk = (Array.isArray(output) ? output : [output])
        .flatMap((result) => ("output" in result ? result.output : []))
        .find((file) => file.fileName === "sw.js");
      if (chunk?.type !== "chunk") this.error("service worker build produced no sw.js");
      this.emitFile({ type: "asset", fileName: "sw.js", source: chunk.code });
    },
  };
}

export default defineConfig({
  server: { port: 3000 },
  // React's plugin must come after Start's plugin.
  plugins: [tanstackStart(), viteReact(), serviceWorker()],
});
