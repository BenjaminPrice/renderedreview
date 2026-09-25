// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { setupRedirect } from "../../../github/install-redirect";

// The GitHub App's Setup URL: GitHub sends the user here after installing, with our `state`.
export const Route = createFileRoute("/api/github/setup")({
  server: { handlers: { GET: ({ request }) => setupRedirect(request) } },
});
