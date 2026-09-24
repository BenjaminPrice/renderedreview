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
