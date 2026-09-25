// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      "packages/*",
      "apps/site",
      { test: { name: "root", include: ["*.test.ts"], benchmark: { include: ["*.bench.ts"] } } },
      {
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          benchmark: { include: ["apps/web/src/**/*.bench.ts"] },
        },
      },
    ],
  },
});
