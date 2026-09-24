// SPDX-License-Identifier: AGPL-3.0-only
// Component-test helper: AppShell links home, so shell-level components need a router around them.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { expect, vi } from "vitest";

export async function renderWithRouter(ui: () => ReactNode, url = "/") {
  const router = createRouter({
    routeTree: createRootRoute({ component: ui }),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

/** An outbound link opens in a new tab without a referrer, and its accessible name says so. */
export function expectNewTab(link: HTMLElement) {
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")?.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
  expect(link.textContent + (link.getAttribute("aria-label") ?? "")).toMatch(/\(opens in new tab\)$/);
}

/** Silences the server logger and returns a reader for the events it emitted (JSON lines). */
export function captureLogs() {
  const spies = (["info", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
  const raw = () => JSON.stringify(spies.map((s) => s.mock.calls));
  const events = () =>
    spies.flatMap((s) => s.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>));
  return { events, raw };
}

/**
 * No serious or critical axe violations under `root`. Colour contrast needs layout, which the test
 * DOM lacks: it is checked from the design tokens instead.
 */
export async function expectNoSeriousA11yViolations(root: Element = document.body) {
  const { violations } = await axe.run(root, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)).toEqual([]);
}

/**
 * Stand-in for `Selection.modify`, which browsers have and the test DOMs lack: extends forward or
 * backward by one character through the document's text. Other granularities are not needed here.
 */
export function stubSelectionModify() {
  Selection.prototype.modify = function (this: Selection, _alter, direction) {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    const focus = this.focusNode!;
    // A boundary between nodes resolves to the next text at or after it.
    let i = texts.indexOf(focus as Text);
    let offset = this.focusOffset;
    if (i < 0) {
      const after = focus.childNodes[offset] ?? focus;
      i = texts.findIndex(
        (t) =>
          after === t || after.contains(t) || !!(after.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      offset = 0;
    }
    const forward = direction === "forward";
    if (forward && offset >= texts[i]!.length) [i, offset] = [i + 1, 0];
    if (!forward && offset === 0) [i, offset] = [i - 1, texts[i - 1]!.length];
    this.extend(texts[i]!, offset + (forward ? 1 : -1));
  };
}
