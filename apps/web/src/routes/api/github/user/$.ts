// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { identityFor } from "../../../../auth";
import { allowedHosts } from "../../../../github/proxy";
import { proxyUserGitHub } from "../../../../github/user-proxy";

export const Route = createFileRoute("/api/github/user/$")({
  // ANY so non-GET methods get an explicit 405 instead of the app shell.
  server: {
    handlers: {
      ANY: async ({ request, context }) =>
        proxyUserGitHub(request, {
          allowedHosts: allowedHosts(context.config),
          identity: await identityFor(context, new URL(request.url).origin),
        }),
    },
  },
});
