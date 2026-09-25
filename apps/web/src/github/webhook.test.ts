// SPDX-License-Identifier: AGPL-3.0-only
// The GitHub webhook receiver over the control-plane database: signature checks, delivery dedup
// and dispatch. Runs on SQLite, and on PostgreSQL when available. Signatures are computed with
// node:crypto as an independent reference for the receiver's Web Crypto check.
import { createHmac } from "node:crypto";
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type RequestContext, type SqlDatabase } from "@rendered-review/runtime";
import { openDatabase, type NodeDatabase } from "@rendered-review/runtime-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { receiveWebhook, type WebhookHandlers } from "./webhook";

const SECRET = "webhook-secret";
const config = loadConfig({
  HOSTING_MODE: "community",
  ACCESS_POLICY: "installed",
  GITHUB_APP_ID: "1",
  GITHUB_APP_CLIENT_ID: "Iv23.app-client",
  GITHUB_APP_CLIENT_SECRET: "app-client-secret",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_WEBHOOK_SECRET: SECRET,
  ENCRYPTION_KEY: btoa("k".repeat(32)),
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-32-chars!",
  DATABASE_URL: "sqlite::memory:",
});
const URL_ = "https://rr.example/api/github/webhook";
const PING = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1, secretMarker: "payload-body-marker" });

const sign = (body: string | Uint8Array, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

let deliveries = 0;
function delivery(
  event: string,
  body = PING,
  { id = `d-${++deliveries}`, headers = {} as Record<string, string | null> } = {},
): Request {
  const all: Record<string, string | null> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": id,
    "x-hub-signature-256": sign(body),
    ...headers,
  };
  return new Request(URL_, {
    method: "POST",
    headers: Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null),
    body,
  });
}

const databases: [string, () => Promise<{ db: NodeDatabase; close: () => Promise<void> }>][] = [
  [
    "SQLite",
    async () => {
      const db = openDatabase("sqlite::memory:");
      return { db, close: () => db.close() };
    },
  ],
];
const postgresUrl = process.env.TEST_POSTGRES_URL;
if (postgresUrl || process.env.CI) {
  databases.push([
    "PostgreSQL",
    async () => {
      if (!postgresUrl) throw new Error("TEST_POSTGRES_URL is required in CI");
      const schema = `rr_webhook_${crypto.randomUUID().replaceAll("-", "")}`;
      const admin = openDatabase(postgresUrl);
      await admin.run(`CREATE SCHEMA ${schema}`);
      const url = new URL(postgresUrl);
      url.searchParams.set("search_path", schema);
      const db = openDatabase(url.toString());
      return {
        db,
        close: async () => {
          await db.close();
          await admin.run(`DROP SCHEMA ${schema} CASCADE`);
          await admin.close();
        },
      };
    },
  ]);
}

const noScheduler = { waitUntil: () => {} };
const noSecrets = { get: async () => undefined };

describe("receiveWebhook without a webhook secret or database", () => {
  it("is disabled: every request answers 404", async () => {
    const community = loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" });
    const bare: RequestContext = { config: community, secrets: noSecrets, scheduler: noScheduler };
    expect((await receiveWebhook(delivery("ping"), bare)).status).toBe(404);
    const noDb: RequestContext = { config, secrets: noSecrets, scheduler: noScheduler };
    expect((await receiveWebhook(delivery("ping"), noDb)).status).toBe(404);
  });
});

describe.each(databases)("receiveWebhook on %s", (_, open) => {
  let db: SqlDatabase;
  let close: () => Promise<void>;
  let context: RequestContext;
  const rows = async () =>
    (await db.all<{ delivery_id: string }>("SELECT delivery_id FROM processed_webhook_event ORDER BY delivery_id")).map(
      (r) => r.delivery_id,
    );

  beforeAll(async () => {
    ({ db, close } = await open());
    await migrate(db);
    context = { config, secrets: noSecrets, scheduler: noScheduler, db };
  });
  afterAll(() => close?.());
  beforeEach(async () => {
    await db.run("DELETE FROM processed_webhook_event");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  describe("verification", () => {
    it("accepts a signed ping and records its delivery", async () => {
      const res = await receiveWebhook(delivery("ping", PING, { id: "ping-1" }), context);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "accepted" });
      expect(await rows()).toEqual(["ping-1"]);
    });

    it.each([
      ["a missing signature", { "x-hub-signature-256": null }],
      ["a signature from another secret", { "x-hub-signature-256": sign(PING, "other-secret") }],
      ["a signature over another body", { "x-hub-signature-256": sign(`${PING} `) }],
      ["a malformed signature", { "x-hub-signature-256": "sha256=zz" }],
      ["a SHA-1 signature", { "x-hub-signature-256": `sha1=${createHmac("sha1", SECRET).update(PING).digest("hex")}` }],
    ])("rejects %s with 401, before any handler or database write", async (_, headers) => {
      const handler = vi.fn(async () => {});
      const res = await receiveWebhook(delivery("ping", PING, { headers }), context, { ping: handler });
      expect(res.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
    });

    it("rejects a body that is not JSON with 415", async () => {
      const res = await receiveWebhook(
        delivery("ping", PING, { headers: { "content-type": "application/x-www-form-urlencoded" } }),
        context,
      );
      expect(res.status).toBe(415);
      expect(await rows()).toEqual([]);
    });

    it.each([
      ["x-github-event", { "x-github-event": null }],
      ["x-github-delivery", { "x-github-delivery": null }],
      ["an x-github-delivery with unsafe characters", { "x-github-delivery": "a b@c" }],
    ])("rejects a delivery missing %s with 400", async (_, headers) => {
      const res = await receiveWebhook(delivery("ping", PING, { headers }), context);
      expect(res.status).toBe(400);
      expect(await rows()).toEqual([]);
    });

    it("rejects methods other than POST with 405", async () => {
      expect((await receiveWebhook(new Request(URL_), context)).status).toBe(405);
    });

    it("rejects an oversized body with 413, whether or not it declares its length", async () => {
      const big = JSON.stringify({ padding: "x".repeat(6 * 1024 * 1024) });
      expect((await receiveWebhook(delivery("ping", big), context)).status).toBe(413);
      // A streamed body with no Content-Length is cut off while reading, not trusted.
      const bytes = new TextEncoder().encode(big);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 65536) controller.enqueue(bytes.subarray(i, i + 65536));
          controller.close();
        },
      });
      const streamed = new Request(URL_, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-github-delivery": "streamed",
          "x-hub-signature-256": sign(bytes),
        },
        body: stream,
        duplex: "half",
      } as RequestInit);
      expect(streamed.headers.get("content-length")).toBeNull();
      expect((await receiveWebhook(streamed, context)).status).toBe(413);
      expect(await rows()).toEqual([]);
    });

    it("rejects a signed body that is not valid JSON with 400", async () => {
      const res = await receiveWebhook(delivery("ping", "{not json"), context);
      expect(res.status).toBe(400);
      expect(await rows()).toEqual([]);
    });
  });

  describe("dedup and dispatch", () => {
    const INSTALL = JSON.stringify({ action: "created", installation: { id: 7 } });

    it("answers a replayed delivery 200 without running its handler again", async () => {
      const handler = vi.fn(async () => {});
      const first = await receiveWebhook(delivery("ping", PING, { id: "r-1" }), context, { ping: handler });
      const replay = await receiveWebhook(delivery("ping", PING, { id: "r-1" }), context, { ping: handler });
      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ outcome: "duplicate" });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await rows()).toEqual(["r-1"]);
    });

    it("runs the handler once for concurrent copies of one delivery", async () => {
      const handler = vi.fn(async () => {});
      const results = await Promise.all(
        [1, 2, 3].map(() => receiveWebhook(delivery("ping", PING, { id: "c-1" }), context, { ping: handler })),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("prefers an event.action handler and passes it the parsed delivery and database", async () => {
      const byAction = vi.fn(async () => {});
      const byEvent = vi.fn(async () => {});
      const res = await receiveWebhook(delivery("installation", INSTALL, { id: "i-1" }), context, {
        "installation.created": byAction,
        installation: byEvent,
      });
      expect(res.status).toBe(200);
      expect(byEvent).not.toHaveBeenCalled();
      expect(byAction).toHaveBeenCalledWith(
        { id: "i-1", event: "installation", action: "created", payload: JSON.parse(INSTALL) },
        expect.objectContaining({ db, config }),
      );
    });

    it("falls back to the event handler for other actions", async () => {
      const byEvent = vi.fn(async () => {});
      await receiveWebhook(delivery("installation", INSTALL.replace("created", "deleted")), context, {
        "installation.created": vi.fn(),
        installation: byEvent,
      });
      expect(byEvent).toHaveBeenCalledOnce();
    });

    it("ignores events without a handler: 200, nothing recorded", async () => {
      const res = await receiveWebhook(delivery("star", JSON.stringify({ action: "created" })), context);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "ignored" });
      // Not even an Object.prototype member resolves to a handler.
      expect((await receiveWebhook(delivery("constructor"), context)).status).toBe(200);
      expect(await rows()).toEqual([]);
    });

    it("handles ping by default", async () => {
      const res = await receiveWebhook(delivery("ping", PING, { id: "p-default" }), context);
      expect(await res.json()).toEqual({ outcome: "accepted" });
    });

    it("answers 500 when a handler fails and leaves the delivery unrecorded, so a redelivery retries", async () => {
      const handler = vi.fn().mockRejectedValueOnce(new TypeError("boom")).mockResolvedValueOnce(undefined);
      const failed = await receiveWebhook(delivery("ping", PING, { id: "f-1" }), context, { ping: handler });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ outcome: "failed" });
      expect(await rows()).toEqual([]);
      const redelivered = await receiveWebhook(delivery("ping", PING, { id: "f-1" }), context, { ping: handler });
      expect(await redelivered.json()).toEqual({ outcome: "accepted" });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(await rows()).toEqual(["f-1"]);
    });
  });

  describe("logging", () => {
    const logged = () =>
      (["info", "warn", "error"] as const).flatMap((level) =>
        vi.mocked(console[level]).mock.calls.map(([line]) => JSON.parse(line as string) as Record<string, unknown>),
      );

    it("logs one github.webhook event per delivery with its ID, event, action, outcome and duration", async () => {
      const failing = { ping: async () => Promise.reject(new TypeError("boom")) };
      const body = JSON.stringify({ action: "created", secretMarker: "payload-body-marker" });
      await receiveWebhook(delivery("installation", body, { id: "l-1" }), context, { installation: async () => {} });
      await receiveWebhook(delivery("installation", body, { id: "l-1" }), context, { installation: async () => {} });
      await receiveWebhook(delivery("star", body, { id: "l-2" }), context);
      await receiveWebhook(delivery("ping", PING, { id: "l-3" }), context, failing);
      await receiveWebhook(delivery("ping", PING, { id: "l-4", headers: { "x-hub-signature-256": null } }), context);
      const events = logged().filter((e) => e.event === "github.webhook");
      expect(events.map(({ durationMs, ...rest }) => (expect(durationMs).toBeTypeOf("number"), rest))).toEqual(
        expect.arrayContaining([
          { level: "info", event: "github.webhook", deliveryId: "l-1", githubEvent: "installation", action: "created", outcome: "accepted", status: 200 },
          { level: "info", event: "github.webhook", deliveryId: "l-1", githubEvent: "installation", action: "created", outcome: "duplicate", status: 200 },
          { level: "info", event: "github.webhook", deliveryId: "l-2", githubEvent: "star", action: "created", outcome: "ignored", status: 200 },
          { level: "error", event: "github.webhook", deliveryId: "l-3", githubEvent: "ping", outcome: "failed", status: 500, error: "TypeError" },
          { level: "warn", event: "github.webhook", deliveryId: "l-4", githubEvent: "ping", outcome: "rejected", status: 401, category: "bad-signature" },
        ]),
      );
      expect(events).toHaveLength(5);
    });

    it("never logs the payload, the signature or the secret", async () => {
      const body = JSON.stringify({ action: "created", secretMarker: "payload-body-marker" });
      await receiveWebhook(delivery("installation", body), context, { installation: async () => {} });
      await receiveWebhook(delivery("installation", body, { headers: { "x-hub-signature-256": sign("x") } }), context);
      await receiveWebhook(delivery("ping", "{not json payload-body-marker"), context);
      const output = JSON.stringify(logged());
      expect(output).not.toContain("payload-body-marker");
      expect(output).not.toContain("sha256=");
      expect(output).not.toContain(SECRET);
    });
  });
});
