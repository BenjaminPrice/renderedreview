// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { receiveWebhook } from "../../../github/webhook";

// GitHub calls this server to server: no session or CSRF check; each delivery is verified by its signature.
export const Route = createFileRoute("/api/github/webhook")({
  // ANY so other methods get an explicit 405 instead of the app shell.
  server: { handlers: { ANY: ({ request, context }) => receiveWebhook(request, context) } },
});
