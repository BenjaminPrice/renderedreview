// SPDX-License-Identifier: AGPL-3.0-only
import type { RequestContext, SqlDatabase } from "@rendered-review/runtime";

export interface WebhookDelivery {
  id: string;
  event: string;
  action?: string;
  payload: unknown;
}
export type WebhookHandler = (delivery: WebhookDelivery, context: RequestContext & { db: SqlDatabase }) => Promise<void>;
export type WebhookHandlers = Readonly<Record<string, WebhookHandler>>;

export async function receiveWebhook(
  _request: Request,
  _context: RequestContext,
  _handlers?: WebhookHandlers,
): Promise<Response> {
  return new Response(null, { status: 501 });
}
