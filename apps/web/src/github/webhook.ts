// SPDX-License-Identifier: AGPL-3.0-only
// Server only: the GitHub App's webhook endpoint. A delivery is checked in order (size, content
// type, headers, then its HMAC-SHA256 signature over the raw body, verified with Web Crypto) before
// its JSON is parsed or anything is written. It is dispatched to a handler by event name, and its
// delivery ID is recorded in the control-plane database once the handler succeeds, so a replay of
// a processed delivery is a no-op and a failed one runs again when GitHub redelivers it. Payloads and signatures are
// never logged. Web Request/Response/crypto only, so Node and Workers run the same code.
import {
  errorName,
  log,
  readBodyCapped,
  type LogFields,
  type RequestContext,
  type SqlDatabase,
} from "@rendered-review/runtime";
import { installationHandlers } from "./installations";

/** A verified, parsed delivery, as handlers receive it. */
export interface WebhookDelivery {
  /** The `X-GitHub-Delivery` GUID. */
  id: string;
  /** The `X-GitHub-Event` name, such as `installation`. */
  event: string;
  /** The payload's `action`, such as `created`, when it has one. */
  action?: string;
  payload: unknown;
}

/**
 * Handles one event. Must be idempotent: a delivery is recorded only after its handler succeeds, so
 * a failure, a crash before the record, or concurrent copies of one delivery can each run it again.
 * Throwing answers 500 and leaves the delivery for a redelivery to retry.
 */
export type WebhookHandler = (
  delivery: WebhookDelivery,
  context: RequestContext & { db: SqlDatabase },
) => Promise<void>;

/** Handlers keyed by `event.action` (preferred) or `event`. Events without a handler are ignored. */
export type WebhookHandlers = Readonly<Record<string, WebhookHandler>>;

/** The deployment's handlers. Register new events here; each must be idempotent (see `WebhookHandler`). */
export const webhookHandlers: WebhookHandlers = {
  // GitHub sends a ping when the webhook is created or its settings change; nothing to do.
  ping: async () => {},
  ...installationHandlers,
};

// GitHub caps payloads at 25 MB, but the events the app subscribes to are far smaller.
export const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const EVENT = /^[a-z_]{1,64}$/;
const DELIVERY_ID = /^[\w-]{1,100}$/;

type Outcome = "accepted" | "duplicate" | "ignored" | "rejected" | "failed";

export async function receiveWebhook(
  request: Request,
  context: RequestContext,
  handlers: WebhookHandlers = webhookHandlers,
): Promise<Response> {
  const secret = context.config.github.app?.webhookSecret;
  const { db } = context;
  // Without a secret nothing can be verified, so the endpoint does not exist.
  if (!secret || !db) return new Response(null, { status: 404 });

  const started = Date.now();
  const fields: LogFields = {};
  const reply = (status: number, outcome: Outcome, extra: Pick<LogFields, "category" | "error"> = {}) => {
    const level = outcome === "failed" ? "error" : outcome === "rejected" ? "warn" : "info";
    log[level]("github.webhook", { ...fields, outcome, status, ...extra, durationMs: Date.now() - started });
    const body = { outcome, ...(extra.category && { reason: extra.category }) };
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  };
  const reject = (status: number, category: string) => reply(status, "rejected", { category });

  if (request.method !== "POST") return reject(405, "method-not-allowed");
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? ""))
    return reject(415, "unsupported-media-type");
  const event = request.headers.get("x-github-event") ?? "";
  const id = request.headers.get("x-github-delivery") ?? "";
  if (!EVENT.test(event) || !DELIVERY_ID.test(id)) return reject(400, "missing-headers");
  // Well-formed, but still unverified until the signature check: rejected lines may carry made-up IDs.
  Object.assign(fields, { deliveryId: id, githubEvent: event });

  const body = await readBodyCapped(request, MAX_WEBHOOK_BYTES);
  if (!body) return reject(413, "too-large");
  if (!(await verifySignature(secret, request.headers.get("x-hub-signature-256"), body)))
    return reject(401, "bad-signature");

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return reject(400, "invalid-json");
  }
  const action = (payload as { action?: unknown } | null)?.action;
  const delivery: WebhookDelivery = { id, event, action: typeof action === "string" ? action : undefined, payload };
  fields.action = delivery.action;
  const handler = pick(handlers, `${event}.${delivery.action}`) ?? pick(handlers, event);
  if (!handler) return reply(200, "ignored");

  const processed = await db.all(
    "SELECT 1 AS found FROM processed_webhook_event WHERE source = ? AND delivery_id = ?",
    ["github", id],
  );
  if (processed.length > 0) return reply(200, "duplicate");
  try {
    await handler(delivery, { ...context, db });
    // Recorded only now: a failure or crash before this line leaves the delivery retryable.
    await db.run(
      "INSERT INTO processed_webhook_event (source, delivery_id, processed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      ["github", id, new Date().toISOString()],
    );
  } catch (error) {
    return reply(500, "failed", { error: errorName(error) });
  }
  return reply(200, "accepted");
}

// Own keys only, so an event named like an Object.prototype member never resolves to one.
const pick = (handlers: WebhookHandlers, key: string) => (Object.hasOwn(handlers, key) ? handlers[key] : undefined);

/** Web Crypto's HMAC verify compares in constant time. */
async function verifySignature(secret: string, header: string | null, body: Uint8Array<ArrayBuffer>) {
  const hex = SIGNATURE.exec(header ?? "")?.[1];
  if (!hex) return false;
  const signature = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, body);
}
