// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { proxyPublicGitHub } from "../../../../github/proxy";

export const Route = createFileRoute("/api/github/public/$")({
  // ANY so non-GET methods get an explicit 405 instead of the app shell.
  server: { handlers: { ANY: ({ request }) => proxyPublicGitHub(request) } },
});
