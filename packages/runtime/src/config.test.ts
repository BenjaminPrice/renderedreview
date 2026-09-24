// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig, type Env, type LoadConfigOptions } from "./config";

const key = btoa("k".repeat(32));
const github = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_CLIENT_ID: "Iv1.app",
  GITHUB_APP_CLIENT_SECRET: "app-client-secret-value",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nprivate-key-value\\n-----END RSA PRIVATE KEY-----",
  GITHUB_APP_WEBHOOK_SECRET: "app-webhook-secret-value",
  GITHUB_OAUTH_CLIENT_ID: "oauth-client",
  GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret-value",
  ENCRYPTION_KEY: key,
  BETTER_AUTH_SECRET: "better-auth-secret-value-at-least-32-chars",
};
const hosted: Env = {
  HOSTING_MODE: "hosted",
  ACCESS_POLICY: "installed",
  ...github,
  DATABASE_URL: "postgres://rr:db-password-value@db.internal:5432/rr",
  BILLING_PROVIDER: "stripe",
  BILLING_API_KEY: "billing-api-key-value",
  BILLING_WEBHOOK_SECRET: "billing-webhook-secret-value",
  GITHUB_PUBLIC_READ_TOKEN: "public-read-token-value",
};

function problems(env: Env, options?: LoadConfigOptions): string[] {
  try {
    loadConfig(env, options);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("loads a full hosted config", () => {
    const config = loadConfig(hosted);
    expect(config.hostingMode).toBe("hosted");
    expect(config.github).toMatchObject({ url: "https://github.com", apiUrl: "https://api.github.com" });
    expect(config.github.app?.privateKey).toContain("\nprivate-key-value\n");
    expect(config.billing).toEqual({
      provider: "stripe",
      apiKey: "billing-api-key-value",
      webhookSecret: "billing-webhook-secret-value",
    });
  });

  it("starts a public-only community instance with nothing but the mode", () => {
    const config = loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" });
    expect(config).toMatchObject({ accessPolicy: "disabled", allowlist: [], billing: undefined });
    expect(config.github.app).toBeUndefined();
  });

  it("starts community mode without billing and ignores stray billing vars", () => {
    const config = loadConfig({
      HOSTING_MODE: "community",
      ACCESS_ALLOWLIST: "acme, octo/docs",
      ...github,
      DATABASE_URL: "sqlite:///var/lib/rendered-review/rr.db",
      BILLING_API_KEY: "ignored",
    });
    expect(config.accessPolicy).toBe("allowlist");
    expect(config.allowlist).toEqual(["acme", "octo/docs"]);
    expect(config.billing).toBeUndefined();
  });

  it("accepts optional OAuth App credentials in community mode, and redacts the secret", () => {
    const base = { HOSTING_MODE: "community", ACCESS_POLICY: "disabled", DATABASE_URL: "sqlite::memory:" };
    const app = { ...github, GITHUB_OAUTH_CLIENT_ID: undefined, GITHUB_OAUTH_CLIENT_SECRET: undefined };
    expect(loadConfig({ ...base, ...app }).github.oauth).toBeUndefined();
    const config = loadConfig({ ...base, ...github });
    expect(config.github.oauth).toEqual({ clientId: "oauth-client", clientSecret: "oauth-client-secret-value" });
    expect(redactConfig(config)).not.toContain("oauth-client-secret-value");
  });

  it("accepts an optional public read token in every hosting mode", () => {
    const token = { GITHUB_PUBLIC_READ_TOKEN: " github_pat_x " };
    expect(loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled", ...token }).github.publicReadToken).toBe(
      "github_pat_x",
    );
    expect(loadConfig(hosted).github.publicReadToken).toBe("public-read-token-value");
    expect(loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" }).github.publicReadToken).toBeUndefined();
  });

  it("defaults ACCESS_POLICY by hosting mode, and an explicit value overrides it", () => {
    const withoutPolicy = { ...hosted, ACCESS_POLICY: undefined };
    expect(loadConfig(withoutPolicy).accessPolicy).toBe("installed");
    expect(loadConfig({ ...withoutPolicy, HOSTING_MODE: "dedicated" }).accessPolicy).toBe("installed");
    expect(problems({ HOSTING_MODE: "community" })).toContain(
      "ACCESS_ALLOWLIST required when ACCESS_POLICY is allowlist (comma-separated owner or owner/repo)",
    );
    expect(loadConfig({ ...withoutPolicy, HOSTING_MODE: "community", ACCESS_ALLOWLIST: "acme" }).accessPolicy).toBe(
      "allowlist",
    );
    expect(loadConfig({ ...hosted, ACCESS_POLICY: "allowlist", ACCESS_ALLOWLIST: "acme" }).accessPolicy).toBe(
      "allowlist",
    );
  });

  it("derives the GitHub Enterprise Server API URL", () => {
    const config = loadConfig({
      HOSTING_MODE: "community",
      ACCESS_POLICY: "disabled",
      GITHUB_URL: "https://ghe.example.com/",
    });
    expect(config.github).toMatchObject({ url: "https://ghe.example.com", apiUrl: "https://ghe.example.com/api/v3" });
  });

  it("reports every missing required value in one readable error", () => {
    expect(() => loadConfig({ HOSTING_MODE: "cloud" })).toThrow(
      /^Invalid configuration:\n {2}- HOSTING_MODE must be one of/,
    );
    expect(problems({ HOSTING_MODE: "hosted" })).toEqual([
      "GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE), GITHUB_APP_WEBHOOK_SECRET required when HOSTING_MODE is hosted",
      "GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET required when HOSTING_MODE is hosted",
      "DATABASE_URL required when HOSTING_MODE is hosted",
      "BILLING_PROVIDER is required (one of polar, stripe)",
      "BILLING_API_KEY, BILLING_WEBHOOK_SECRET required when HOSTING_MODE is hosted",
    ]);
  });

  it("requires the GitHub App, encryption key and database for private access in community mode", () => {
    expect(problems({ HOSTING_MODE: "community", ACCESS_POLICY: "installed" })).toEqual([
      "GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE), GITHUB_APP_WEBHOOK_SECRET required for private repository access (ACCESS_POLICY is installed)",
    ]);
    expect(problems({ HOSTING_MODE: "community", ACCESS_POLICY: "installed", ...github, ENCRYPTION_KEY: "" })).toEqual([
      "ENCRYPTION_KEY required when GitHub credentials are set: 32 random bytes, base64-encoded (openssl rand -base64 32)",
      "DATABASE_URL required when GitHub credentials are set",
    ]);
  });

  it("requires a session secret for GitHub App sign-in, separate from the encryption key", () => {
    expect(problems({ ...hosted, BETTER_AUTH_SECRET: undefined })).toEqual([
      "BETTER_AUTH_SECRET required when GitHub App credentials are set: at least 32 random characters (openssl rand -base64 32)",
    ]);
    expect(problems({ ...hosted, BETTER_AUTH_SECRET: "short" })).toEqual([
      "BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)",
    ]);
    expect(loadConfig(hosted).authSecret).toBe("better-auth-secret-value-at-least-32-chars");
  });

  it("accepts a previous encryption key for rotation", () => {
    const previous = btoa("p".repeat(32));
    expect(loadConfig({ ...hosted, ENCRYPTION_KEY_PREVIOUS: previous }).previousEncryptionKey).toBe(previous);
    expect(problems({ ...hosted, ENCRYPTION_KEY_PREVIOUS: "short" })).toEqual([
      "ENCRYPTION_KEY_PREVIOUS must be 32 random bytes, base64-encoded",
    ]);
  });

  it("does not require DATABASE_URL when the runtime binds the database", () => {
    const env = { ...hosted, DATABASE_URL: undefined };
    expect(loadConfig(env, { databaseBinding: true }).databaseUrl).toBeUndefined();
  });

  it("leads with a hint when no configuration variable is set at all", () => {
    for (const env of [{}, { PATH: "/usr/bin", HOME: "/home/me" }]) {
      expect(() => loadConfig(env)).toThrow(
        /^No configuration found — is your env file being loaded\? \(see README: \.env\.local \+ direnv\)\nInvalid configuration:\n {2}- HOSTING_MODE is required/,
      );
    }
    expect(() => loadConfig({ ACCESS_POLICY: "disabled" })).toThrow(/^Invalid configuration:/);
  });

  it("takes the GitHub App private key from a file the runtime read", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nfile-key-value\n-----END RSA PRIVATE KEY-----\n";
    const env = { ...hosted, GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_APP_PRIVATE_KEY_FILE: "github-app.pem" };
    const config = loadConfig(env, { githubAppPrivateKeyFile: pem });
    expect(config.github.app?.privateKey).toBe(pem.trim());
    expect(redactConfig(config)).not.toContain("file-key-value");
    expect(
      problems({ ...env, GITHUB_APP_PRIVATE_KEY: hosted.GITHUB_APP_PRIVATE_KEY }, { githubAppPrivateKeyFile: pem }),
    ).toEqual(["Set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE, not both"]);
    // Runtimes without a filesystem (Workers) never pass file contents.
    expect(problems(env)).toContain(
      "GITHUB_APP_PRIVATE_KEY_FILE is not supported by this runtime; set GITHUB_APP_PRIVATE_KEY",
    );
  });

  it("loads a private key stored with real newlines (wrangler secret put) or escaped \\n (env files)", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nline-one\nline-two\n-----END RSA PRIVATE KEY-----";
    // What a Worker in public-only community mode with sign-in secrets sees; pasted keys often end in a newline.
    const worker = { HOSTING_MODE: "community", ACCESS_POLICY: "disabled", ...github, DATABASE_URL: undefined };
    for (const stored of [`${pem}\n`, pem.replaceAll("\n", "\\n")]) {
      const config = loadConfig({ ...worker, GITHUB_APP_PRIVATE_KEY: stored }, { databaseBinding: true });
      expect(config.github.app?.privateKey).toBe(pem);
    }
  });

  it("rejects malformed values", () => {
    expect(
      problems({
        HOSTING_MODE: "cloud",
        ACCESS_POLICY: "allowlist",
        ACCESS_ALLOWLIST: "acme/docs/extra",
        GITHUB_URL: "ghe.example.com",
        GITHUB_OAUTH_CLIENT_ID: "only-half",
        ENCRYPTION_KEY: "short",
        DATABASE_URL: "mysql://db",
      }),
    ).toEqual([
      'HOSTING_MODE must be one of community, dedicated, hosted (got "cloud")',
      'ACCESS_ALLOWLIST entry "acme/docs/extra" is not owner or owner/repo',
      'GITHUB_URL must be an http(s) URL (got "ghe.example.com")',
      "GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE), GITHUB_APP_WEBHOOK_SECRET required for private repository access (ACCESS_POLICY is allowlist)",
      "GITHUB_OAUTH_CLIENT_SECRET required (set all or none of GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET)",
      "ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)",
      "DATABASE_URL must be a postgres://, postgresql://, sqlite://, file:// URL",
    ]);
  });
});

describe("redactConfig", () => {
  it("never includes a secret value", () => {
    const dump = redactConfig(loadConfig(hosted));
    for (const secret of [
      "app-client-secret-value",
      "private-key-value",
      "app-webhook-secret-value",
      "oauth-client-secret-value",
      key,
      "db-password-value",
      "billing-api-key-value",
      "billing-webhook-secret-value",
      "better-auth-secret-value-at-least-32-chars",
      "public-read-token-value",
    ]) {
      expect(dump).not.toContain(secret);
    }
    expect(JSON.parse(dump)).toMatchObject({
      hostingMode: "hosted",
      github: { app: { id: "123", clientId: "Iv1.app", clientSecret: "[redacted]" } },
      databaseUrl: "postgres://rr:redacted@db.internal:5432/rr",
    });
  });
});
