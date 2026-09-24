// SPDX-License-Identifier: AGPL-3.0-only
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { domainPackages } from "./eslint.config";

const eslint = new ESLint({ cwd: import.meta.dirname });

async function restrictedImports(pkg: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: `packages/${pkg}/src/fixture.ts` });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports");
}

const violations = [
  'import { readFile } from "node:fs/promises";',
  'import fs from "fs";',
  'import path from "path";',
  'import { env } from "cloudflare:workers";',
  'import type { D1Database } from "@cloudflare/workers-types";',
  'import pg from "pg";',
  'import Database from "better-sqlite3";',
  'import { betterAuth } from "better-auth";',
  'export * from "@rendered-review/runtime-node";',
  'import "@rendered-review/runtime-cloudflare";',
  'import "@rendered-review/identity";',
  'import "@rendered-review/control-plane";',
];

describe("domain boundary rule", () => {
  for (const pkg of domainPackages) {
    it.each(violations)(`${pkg} rejects %s`, async (code) => {
      expect(await restrictedImports(pkg, code)).toHaveLength(1);
    });

    it(`${pkg} allows portable imports`, async () => {
      expect(await restrictedImports(pkg, 'import "@rendered-review/review-domain";')).toHaveLength(0);
    });
  }

  it("does not apply to runtime packages", async () => {
    expect(await restrictedImports("runtime-node", 'import fs from "node:fs";')).toHaveLength(0);
  });
});
