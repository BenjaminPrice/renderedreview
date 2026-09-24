// SPDX-License-Identifier: AGPL-3.0-only
import { builtinModules } from "node:module";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

// Domain packages must stay portable: Web Platform APIs and narrow interfaces only.
// Runtime adapters supply persistence, secrets and request integration.
export const domainPackages = ["review-domain", "markdown-domain", "diagram-domain", "annotation-domain"];

const boundary = "Domain packages must not depend on runtime-specific APIs; inject them through an interface.";

export default tseslint.config(
  { ignores: ["**/dist/", "**/.output/", "**/.wrangler/", "**/routeTree.gen.ts"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: domainPackages.map((name) => `packages/${name}/**`),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules.map((name) => ({ name, message: `Node built-in. ${boundary}` })),
          patterns: [
            { group: ["node:*"], message: `Node built-in. ${boundary}` },
            { group: ["cloudflare:*", "@cloudflare/*"], message: `Cloudflare API. ${boundary}` },
            {
              group: [
                "pg",
                "postgres",
                "@neondatabase/*",
                "mysql2",
                "sqlite3",
                "better-sqlite3",
                "@libsql/*",
                "drizzle-orm",
                "drizzle-orm/*",
                "kysely",
                "kysely/*",
              ],
              message: `Database driver. ${boundary}`,
            },
            { group: ["better-auth", "better-auth/*"], message: `Session/auth code. ${boundary}` },
            {
              group: [
                "@rendered-review/runtime-node",
                "@rendered-review/runtime-cloudflare",
                "@rendered-review/identity",
                "@rendered-review/control-plane",
              ],
              message: `Runtime, identity and control-plane packages are off limits. ${boundary}`,
            },
          ],
        },
      ],
    },
  },
  prettier,
);
