// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

// Top-level rules as [selector, body], in source order. Enough for this flat stylesheet.
const rules = [...readFileSync(`${import.meta.dirname}/styles.css`, "utf8").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector, body]) => [selector!.replace(/\/\*[\s\S]*?\*\//g, "").trim(), body!] as const,
);

it("gives focused comment anchors the focus ring, after every other anchor outline so it wins", () => {
  const anchorRules = rules.filter(([selector]) => selector.includes("[data-rr-anchor]"));
  const focus = anchorRules
    .map(([selector, body]) => selector.includes(":focus-visible") && /outline:[^;]*var\(--rr-focus\)/.test(body))
    .lastIndexOf(true);
  expect(focus, "no [data-rr-anchor]:focus-visible rule with the --rr-focus outline").toBeGreaterThan(-1);
  // Same specificity as `[data-rr-anchor][data-rr-active]`, so it must come last to override it.
  expect(focus).toBe(anchorRules.length - 1);
});

it("underlines links in running text, which colour alone does not set apart (WCAG 1.4.1)", () => {
  expect(
    rules.some(([selector, body]) => /(^|,)\s*p a\b/.test(selector) && /text-decoration:\s*underline/.test(body)),
  ).toBe(true);
});

it("reflows to one column on narrow viewports and at 200% zoom (WCAG 1.4.10)", () => {
  const css = readFileSync(`${import.meta.dirname}/styles.css`, "utf8");
  const narrow = /@media \(max-width: 40rem\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  for (const layout of [".rr-body", ".rr-canvas"])
    expect(narrow, layout).toMatch(new RegExp(`\\${layout} \\{[^}]*grid-template-columns: minmax\\(0, 1fr\\);`));
});

it("takes the shared design tokens from @rendered-review/design-tokens and defines every other token it uses", () => {
  const css = readFileSync(`${import.meta.dirname}/styles.css`, "utf8");
  const tokens = readFileSync(
    createRequire(import.meta.url).resolve("@rendered-review/design-tokens/tokens.css"),
    "utf8",
  );
  expect(css).toMatch(/^(\/\*[\s\S]*?\*\/\s*)*@import "@rendered-review\/design-tokens\/tokens\.css";/);
  const defined = (source: string) => new Set([...source.matchAll(/(--rr-[\w-]+)\s*:/g)].map(([, name]) => name!));
  const shared = defined(tokens);
  const local = defined(css);
  expect(
    [...local].filter((name) => shared.has(name)),
    "redefined shared tokens",
  ).toEqual([]);
  const used = [...(css + tokens).matchAll(/var\((--rr-[\w-]+)/g)].map(([, name]) => name!);
  expect(
    [...new Set(used)].filter((name) => !shared.has(name) && !local.has(name)),
    "undefined tokens",
  ).toEqual([]);
});
