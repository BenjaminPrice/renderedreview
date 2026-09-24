// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { rendererFrameResponse } from "../diagram/frame";

export const Route = createFileRoute("/frames/renderer")({
  server: { handlers: { GET: ({ request }) => rendererFrameResponse(request) } },
});
