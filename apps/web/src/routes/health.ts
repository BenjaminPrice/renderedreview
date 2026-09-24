// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: () => Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } }),
    },
  },
});
