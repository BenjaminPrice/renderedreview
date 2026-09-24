// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from "vitest";
import { migrations, splitStatements } from "./migrate";

it("splits statements on line-ending semicolons and drops comments", () => {
  expect(splitStatements("-- note;\nCREATE TABLE a (x TEXT);\n\nINSERT INTO a VALUES ('a;b');\n-- end\n")).toEqual([
    "CREATE TABLE a (x TEXT)",
    "INSERT INTO a VALUES ('a;b')",
  ]);
});

it("loads the numbered migration files in order", () => {
  expect(migrations[0]?.name).toBe("0001_initial");
  expect(migrations.map((m) => m.name)).toEqual(migrations.map((m) => m.name).sort());
});
