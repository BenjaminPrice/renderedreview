// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { installRedirect } from "../../../github/install-redirect";

export const Route = createFileRoute("/api/github/install")({
  server: { handlers: { GET: ({ request, context }) => installRedirect(request, context.config) } },
});
