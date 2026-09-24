// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { identityFor } from "../../../../auth";
import { installationCheckFor } from "../../../../github/installation";
import { allowedHosts } from "../../../../github/proxy";
import { publishToGitHub } from "../../../../github/publish";

export const Route = createFileRoute("/api/github/write/$")({
  // ANY so other methods get an explicit 405 instead of the app shell.
  server: {
    handlers: {
      ANY: async ({ request, context }) =>
        publishToGitHub(request, {
          allowedHosts: allowedHosts(context.config),
          identity: await identityFor(context, new URL(request.url).origin),
          installed: installationCheckFor(context.config),
        }),
    },
  },
});
