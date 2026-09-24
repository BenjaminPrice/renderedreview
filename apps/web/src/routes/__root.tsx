// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Rendered Review" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  useEffect(() => {
    // Production only: in dev, Vite serves unhashed modules that must never be cached.
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((error: unknown) => console.error("Service worker registration failed", error));
    }
  }, []);
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
