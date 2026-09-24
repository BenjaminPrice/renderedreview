// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { normalizeText } from "./normalize.js";

test("line endings and Unicode composition compare equal", () => {
  expect(normalizeText("a\r\nb\rc\n")).toBe(normalizeText("a\nb\nc\n"));
  expect(normalizeText("Cafe\u0301")).toBe(normalizeText("Caf\u00e9"));
});

test("punctuation and whitespace differences stay unequal", () => {
  const n = normalizeText;
  expect(n("don't")).not.toBe(n("dont"));
  expect(n("don't")).not.toBe(n("don\u2019t"));
  expect(n("a  b")).not.toBe(n("a b"));
  expect(n("a\tb")).not.toBe(n("a b"));
  expect(n("a\u00a0b")).not.toBe(n("a b"));
  expect(n(" a ")).not.toBe(n("a"));
  expect(n("a\n\nb")).not.toBe(n("a\nb"));
  expect(n("**a**")).not.toBe(n("a"));
});
