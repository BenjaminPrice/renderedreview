// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@rendered-review/runtime";
import { describe, expect, it } from "vitest";
import { loadNodeConfig } from "./config";

const env = {
  HOSTING_MODE: "community",
  ACCESS_POLICY: "installed",
  GITHUB_APP_ID: "123",
  GITHUB_APP_CLIENT_ID: "Iv1.app",
  GITHUB_APP_CLIENT_SECRET: "app-client-secret-value",
  GITHUB_APP_WEBHOOK_SECRET: "app-webhook-secret-value",
  ENCRYPTION_KEY: btoa("k".repeat(32)),
  BETTER_AUTH_SECRET: "better-auth-secret-value-at-least-32-chars",
  DATABASE_URL: "sqlite::memory:",
};

describe("loadNodeConfig", () => {
  it("reads the GitHub App private key from GITHUB_APP_PRIVATE_KEY_FILE", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nline-one\nline-two\n-----END RSA PRIVATE KEY-----";
    const path = join(mkdtempSync(join(tmpdir(), "rr-key-")), "app.pem");
    writeFileSync(path, `${pem}\n`);
    expect(loadNodeConfig({ ...env, GITHUB_APP_PRIVATE_KEY_FILE: path }).github.app?.privateKey).toBe(pem);
  });

  it("reports a key file it cannot read", () => {
    const missing = join(tmpdir(), "rr-missing", "app.pem");
    expect(() => loadNodeConfig({ ...env, GITHUB_APP_PRIVATE_KEY_FILE: missing })).toThrow(ConfigError);
    expect(() => loadNodeConfig({ ...env, GITHUB_APP_PRIVATE_KEY_FILE: missing })).toThrow(
      /GITHUB_APP_PRIVATE_KEY_FILE could not be read: ENOENT/,
    );
  });
});
