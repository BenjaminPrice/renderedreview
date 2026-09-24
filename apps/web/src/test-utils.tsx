// SPDX-License-Identifier: AGPL-3.0-only
// Component-test helper: AppShell links home, so shell-level components need a router around them.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

export async function renderWithRouter(ui: () => ReactNode) {
  const router = createRouter({ routeTree: createRootRoute({ component: ui }), history: createMemoryHistory() });
  await router.load();
  return render(<RouterProvider router={router} />);
}
