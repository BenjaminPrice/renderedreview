// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
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
  expect(rules.some(([selector, body]) => /(^|,)\s*p a\b/.test(selector) && /text-decoration:\s*underline/.test(body))).toBe(
    true,
  );
});

it("reflows to one column on narrow viewports and at 200% zoom (WCAG 1.4.10)", () => {
  const css = readFileSync(`${import.meta.dirname}/styles.css`, "utf8");
  const narrow = /@media \(max-width: 40rem\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  for (const layout of [".rr-body", ".rr-canvas"])
    expect(narrow, layout).toMatch(new RegExp(`\\${layout} \\{[^}]*grid-template-columns: minmax\\(0, 1fr\\);`));
});
