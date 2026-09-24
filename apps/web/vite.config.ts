// SPDX-License-Identifier: AGPL-3.0-only
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 3000 },
  // React's plugin must come after Start's plugin.
  plugins: [tanstackStart(), viteReact()],
});
