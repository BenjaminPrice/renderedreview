// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // A new QueryClient per router, so SSR requests never share cache state.
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // Server: this request's CSP nonce (server.ts). Client: undefined; Start reads the nonce
    // from the csp-nonce meta tag it renders.
    ssr: { nonce: getGlobalStartContext()?.nonce },
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
