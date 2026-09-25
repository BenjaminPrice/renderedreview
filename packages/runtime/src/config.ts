// SPDX-License-Identifier: AGPL-3.0-only
// Typed configuration shared by every build. Takes a plain env record so each runtime
// supplies its own source (process.env on Node, bindings on Workers).

const hostingModes = ["community", "dedicated", "hosted"] as const;
const accessPolicies = ["disabled", "allowlist", "installed", "all-accessible"] as const;
const billingProviders = ["polar", "stripe"] as const;

export type HostingMode = (typeof hostingModes)[number];
export type AccessPolicy = (typeof accessPolicies)[number];
export type BillingProviderName = (typeof billingProviders)[number];

// Secret fields must use a key listed in `secretKeys` so the config dump redacts them.
export interface AppConfig {
  hostingMode: HostingMode;
  accessPolicy: AccessPolicy;
  /** `owner` or `owner/repo` entries. Empty unless the policy is `allowlist`. */
  allowlist: string[];
  github: {
    /** Web base URL: https://github.com or a GitHub Enterprise Server URL. */
    url: string;
    apiUrl: string;
    app?: { id: string; clientId: string; clientSecret: string; privateKey: string; webhookSecret: string };
    oauth?: { clientId: string; clientSecret: string };
    /** Operator token for public reads through the server proxy (local dev, self-hosting). */
    publicReadToken?: string;
  };
  /** Base64 of 32 bytes; encrypts persisted GitHub tokens. Present whenever GitHub credentials are. */
  encryptionKey?: string;
  /** The key being rotated out: still decrypts, never encrypts. */
  previousEncryptionKey?: string;
  /** Signs sessions and OAuth state (Better Auth). Present whenever the GitHub App is. */
  authSecret?: string;
  databaseUrl?: string;
  /** Only in hosted mode. */
  billing?: { provider: BillingProviderName; apiKey: string; webhookSecret: string };
  /**
   * Node only: the header, lower-case, in which the operator's reverse proxy passes the client
   * address. Undefined: the socket's peer address. Workers always use `CF-Connecting-IP`.
   */
  trustedProxyHeader?: string;
  /** Abuse limits. On Workers the guest and auth limits come from the Rate Limiting bindings instead. */
  limits: { guestPerMinute: number; authPerMinute: number; writesPerMinute: number; trialStartsPerDay: number };
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions {
  /** The runtime provides the database as a platform binding (Workers D1), so DATABASE_URL is not needed. */
  databaseBinding?: boolean;
  /**
   * Contents of the file named by GITHUB_APP_PRIVATE_KEY_FILE, read by a runtime with a filesystem (Node).
   * Config stays platform-neutral, so the loader never reads files itself.
   */
  githubAppPrivateKeyFile?: string;
}

export class ConfigError extends Error {
  constructor(
    readonly problems: string[],
    headline?: string,
  ) {
    super(`${headline ? `${headline}\n` : ""}Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const allowlistEntry = /^[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/;
const databaseProtocols = ["postgres:", "postgresql:", "sqlite:", "file:"];
// The group label for the key, whichever variable supplies it.
const privateKeyVar = "GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE)";

/** Validates `env` and returns typed config, or throws a ConfigError listing every problem. */
export function loadConfig(env: Env, options: LoadConfigOptions = {}): AppConfig {
  const problems: string[] = [];
  // Tracks whether any configuration variable is set, to spot an env file that was never loaded.
  let anySet = false;
  const vars: Env = { ...env, [privateKeyVar]: env.GITHUB_APP_PRIVATE_KEY || options.githubAppPrivateKeyFile };
  const read = (name: string) => {
    const value = vars[name]?.trim() || undefined;
    if (value) anySet = true;
    return value;
  };

  if (read("GITHUB_APP_PRIVATE_KEY_FILE")) {
    if (read("GITHUB_APP_PRIVATE_KEY")) {
      problems.push("Set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE, not both");
    } else if (options.githubAppPrivateKeyFile === undefined) {
      problems.push("GITHUB_APP_PRIVATE_KEY_FILE is not supported by this runtime; set GITHUB_APP_PRIVATE_KEY");
    }
  }

  function oneOf<T extends string>(name: string, values: readonly T[], fallback?: T): T {
    const value = read(name) ?? fallback;
    if (value && (values as readonly string[]).includes(value)) return value as T;
    problems.push(
      value
        ? `${name} must be one of ${values.join(", ")} (got "${value}")`
        : `${name} is required (one of ${values.join(", ")})`,
    );
    // Continue with the least demanding value (listed first) so one bad value does not cascade.
    return values[0]!;
  }

  // A credential set is all-or-nothing. `requiredWhen` names the condition that makes it mandatory.
  function group<K extends string>(vars: Record<K, string>, requiredWhen?: string): Record<K, string> | undefined {
    const names = Object.values<string>(vars);
    const missing = names.filter((name) => !read(name));
    if (missing.length === 0) {
      return Object.fromEntries(Object.entries<string>(vars).map(([key, name]) => [key, read(name)])) as Record<
        K,
        string
      >;
    }
    if (requiredWhen) problems.push(`${missing.join(", ")} required ${requiredWhen}`);
    else if (missing.length < names.length)
      problems.push(`${missing.join(", ")} required (set all or none of ${names.join(", ")})`);
    return undefined;
  }

  const hostingMode = oneOf("HOSTING_MODE", hostingModes);
  // Community installs default to a local allowlist; hosted and dedicated access follows the GitHub App installation.
  const accessPolicy = oneOf("ACCESS_POLICY", accessPolicies, hostingMode === "community" ? "allowlist" : "installed");

  let allowlist: string[] = [];
  if (accessPolicy === "allowlist") {
    allowlist = (read("ACCESS_ALLOWLIST") ?? "").split(/[\s,]+/).filter(Boolean);
    if (allowlist.length === 0) {
      problems.push("ACCESS_ALLOWLIST required when ACCESS_POLICY is allowlist (comma-separated owner or owner/repo)");
    }
    for (const entry of allowlist) {
      if (!allowlistEntry.test(entry)) problems.push(`ACCESS_ALLOWLIST entry "${entry}" is not owner or owner/repo`);
    }
  }

  const github = githubUrls(read("GITHUB_URL") ?? "https://github.com", problems);

  const app = group(
    {
      id: "GITHUB_APP_ID",
      clientId: "GITHUB_APP_CLIENT_ID",
      clientSecret: "GITHUB_APP_CLIENT_SECRET",
      privateKey: privateKeyVar,
      webhookSecret: "GITHUB_APP_WEBHOOK_SECRET",
    },
    hostingMode !== "community"
      ? `when HOSTING_MODE is ${hostingMode}`
      : accessPolicy !== "disabled"
        ? `for private repository access (ACCESS_POLICY is ${accessPolicy})`
        : undefined,
  );
  // Env files often carry PEM keys on one line with literal \n.
  if (app) app.privateKey = app.privateKey.replaceAll("\\n", "\n");

  const oauth = group(
    { clientId: "GITHUB_OAUTH_CLIENT_ID", clientSecret: "GITHUB_OAUTH_CLIENT_SECRET" },
    hostingMode === "hosted" ? "when HOSTING_MODE is hosted" : undefined,
  );

  // Stored credentials and sessions need encryption and a database.
  const storesCredentials = app !== undefined || oauth !== undefined;
  const encryptionKey = read("ENCRYPTION_KEY");
  if (encryptionKey ? !is32ByteBase64(encryptionKey) : storesCredentials) {
    problems.push(
      `ENCRYPTION_KEY ${encryptionKey ? "must be" : "required when GitHub credentials are set:"} 32 random bytes, base64-encoded (openssl rand -base64 32)`,
    );
  }

  const previousEncryptionKey = read("ENCRYPTION_KEY_PREVIOUS");
  if (previousEncryptionKey && !is32ByteBase64(previousEncryptionKey)) {
    problems.push("ENCRYPTION_KEY_PREVIOUS must be 32 random bytes, base64-encoded");
  }

  // GitHub App user authorization is the sign-in flow, so its credentials imply sessions.
  const authSecret = read("BETTER_AUTH_SECRET");
  if (authSecret ? authSecret.length < 32 : app !== undefined) {
    problems.push(
      authSecret
        ? "BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)"
        : "BETTER_AUTH_SECRET required when GitHub App credentials are set: at least 32 random characters (openssl rand -base64 32)",
    );
  }

  const databaseUrl = read("DATABASE_URL");
  if (databaseUrl) {
    if (!databaseProtocols.includes(parseUrl(databaseUrl)?.protocol ?? "")) {
      problems.push(`DATABASE_URL must be a ${databaseProtocols.map((p) => `${p}//`).join(", ")} URL`);
    }
  } else if (!options.databaseBinding && (storesCredentials || hostingMode !== "community")) {
    problems.push(
      hostingMode !== "community"
        ? `DATABASE_URL required when HOSTING_MODE is ${hostingMode}`
        : "DATABASE_URL required when GitHub credentials are set",
    );
  }

  let billing: AppConfig["billing"];
  if (hostingMode === "hosted") {
    const provider = oneOf("BILLING_PROVIDER", billingProviders);
    const creds = group(
      { apiKey: "BILLING_API_KEY", webhookSecret: "BILLING_WEBHOOK_SECRET" },
      "when HOSTING_MODE is hosted",
    );
    if (creds) billing = { provider, ...creds };
  }

  const trustedProxyHeader = read("TRUSTED_PROXY_HEADER")?.toLowerCase();
  if (trustedProxyHeader && !/^[!#$%&'*+.^`|~\w-]+$/.test(trustedProxyHeader))
    problems.push(`TRUSTED_PROXY_HEADER must be an HTTP header name (got "${trustedProxyHeader}")`);
  const count = (name: string, fallback: number) => {
    const value = read(name);
    if (value === undefined) return fallback;
    if (/^[1-9]\d{0,8}$/.test(value)) return Number(value);
    problems.push(`${name} must be a positive integer (got "${value}")`);
    return fallback;
  };
  const limits = {
    guestPerMinute: count("RATE_LIMIT_GUEST_PER_MINUTE", 120),
    authPerMinute: count("RATE_LIMIT_AUTH_PER_MINUTE", 20),
    writesPerMinute: count("RATE_LIMIT_WRITES_PER_MINUTE", 60),
    trialStartsPerDay: count("TRIAL_STARTS_PER_DAY", 3),
  };

  if (problems.length > 0) {
    throw new ConfigError(
      problems,
      anySet ? undefined : "No configuration found — is your env file being loaded? (see README: .env.local + direnv)",
    );
  }
  return {
    hostingMode,
    accessPolicy,
    allowlist,
    github: { ...github, app, oauth, publicReadToken: read("GITHUB_PUBLIC_READ_TOKEN") },
    encryptionKey,
    previousEncryptionKey,
    authSecret,
    databaseUrl,
    billing,
    trustedProxyHeader,
    limits,
  };
}

const secretKeys = new Set([
  "clientSecret",
  "privateKey",
  "webhookSecret",
  "encryptionKey",
  "previousEncryptionKey",
  "authSecret",
  "apiKey",
  "publicReadToken",
]);

/** JSON dump of the config that is safe to log: secrets replaced, database password stripped. */
export function redactConfig(config: AppConfig): string {
  return JSON.stringify(config, (key, value: unknown) => {
    if (secretKeys.has(key) && value !== undefined) return "[redacted]";
    if (key === "databaseUrl" && typeof value === "string") {
      const url = parseUrl(value);
      if (!url) return "[redacted]";
      if (url.password) url.password = "redacted";
      return url.toString();
    }
    return value;
  });
}

function githubUrls(raw: string, problems: string[]) {
  const url = parseUrl(raw);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    problems.push(`GITHUB_URL must be an http(s) URL (got "${raw}")`);
    return { url: raw, apiUrl: raw };
  }
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  // github.com serves its API from a separate host; Enterprise Server serves it under /api/v3.
  return { url: base, apiUrl: url.hostname === "github.com" ? "https://api.github.com" : `${base}/api/v3` };
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function is32ByteBase64(value: string): boolean {
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
}
