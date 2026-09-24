// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { handleAuthRequest } from "../../../auth";

// Under /api/, so the service worker never touches it.
export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { ANY: ({ request, context }) => handleAuthRequest(request, context) } },
});
