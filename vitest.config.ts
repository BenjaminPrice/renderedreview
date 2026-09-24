// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ["packages/*", { test: { name: "root", include: ["*.test.ts"] } }],
  },
});
