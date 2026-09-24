// SPDX-License-Identifier: AGPL-3.0-only
// Component-test helper: AppShell links home, so shell-level components need a router around them.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
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
