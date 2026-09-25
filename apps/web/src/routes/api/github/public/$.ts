// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { allowedHosts, proxyPublicGitHub } from "../../../../github/proxy";
import { limitClient } from "../../../../rate-limit";

export const Route = createFileRoute("/api/github/public/$")({
  // ANY so non-GET methods get an explicit 405 instead of the app shell.
  server: {
    handlers: {
      ANY: ({ request, context }) => {
        const { config } = context;
        const token = config.github.publicReadToken;
        return proxyPublicGitHub(request, {
          allowedHosts: allowedHosts(config),
          readToken: token ? { host: new URL(config.github.url).host, token } : undefined,
          limit: () => limitClient(context, "guest", request),
        });
      },
    },
  },
});
