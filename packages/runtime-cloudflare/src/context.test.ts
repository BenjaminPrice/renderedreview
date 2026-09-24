// SPDX-License-Identifier: AGPL-3.0-only
import { ConfigError } from "@rendered-review/runtime";
import { describe, expect, it, vi } from "vitest";
import { buildRequestContext } from "./context";

const d1Binding = { prepare: () => undefined };
const publicOnly = { HOSTING_MODE: "community", ACCESS_POLICY: "disabled" };

describe("buildRequestContext", () => {
  it("builds config and secrets from string bindings, ignoring other bindings", async () => {
    const env = { ...publicOnly, SOME_SECRET: "secret-value", DB: d1Binding };
    const context = buildRequestContext(env, () => {});
    expect(context.config).toMatchObject({ hostingMode: "community", accessPolicy: "disabled" });
    expect(await context.secrets.get("SOME_SECRET")).toBe("secret-value");
    expect(await context.secrets.get("DB")).toBeUndefined();
    expect(await context.secrets.get("MISSING")).toBeUndefined();
    expect(context.db).toBeDefined();
    expect(buildRequestContext(publicOnly, () => {}).db).toBeUndefined();
  });

  it("does not require DATABASE_URL because D1 is bound", () => {
    const env = {
      HOSTING_MODE: "community",
      ACCESS_POLICY: "installed",
      GITHUB_APP_ID: "1",
      GITHUB_APP_CLIENT_ID: "Iv1.app",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: "pem",
      GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
      ENCRYPTION_KEY: btoa("k".repeat(32)),
      DB: d1Binding,
    };
    expect(buildRequestContext(env, () => {}).config.databaseUrl).toBeUndefined();
  });

  it("hands background work to the execution context's waitUntil", () => {
    const waitUntil = vi.fn();
    const work = Promise.resolve();
    buildRequestContext(publicOnly, waitUntil).scheduler.waitUntil(work);
    expect(waitUntil).toHaveBeenCalledWith(work);
  });

  it("throws a readable ConfigError for invalid vars", () => {
    expect(() => buildRequestContext({}, () => {})).toThrow(ConfigError);
  });
});
