// SPDX-License-Identifier: AGPL-3.0-only
import type { AppConfig } from "@rendered-review/runtime";

export async function installRedirect(_request: Request, _config: AppConfig, _fetch = fetch): Promise<Response> {
  return new Response(null, { status: 501 });
}

export function setupRedirect(_request: Request): Response {
  return new Response(null, { status: 501 });
}
