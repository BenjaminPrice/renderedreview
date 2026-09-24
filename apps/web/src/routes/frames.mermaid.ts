// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { mermaidFrameResponse } from "../diagram/frame";

export const Route = createFileRoute("/frames/mermaid")({
  server: { handlers: { GET: ({ request }) => mermaidFrameResponse(request) } },
});
