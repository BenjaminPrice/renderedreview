// SPDX-License-Identifier: AGPL-3.0-only
// GitHub sign-in end to end through Better Auth over the control-plane database, with GitHub's
// OAuth and REST endpoints answered by stubs. Runs on SQLite, and on PostgreSQL when available.
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type SqlDatabase } from "@rendered-review/runtime";
import { openDatabase, type NodeDatabase } from "@rendered-review/runtime-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authEnabled, createIdentity, type Identity } from "./identity";
import { createTokenCipher } from "./token-cipher";

const key = btoa("k".repeat(32));
const env = {
  HOSTING_MODE: "community",
  ACCESS_POLICY: "installed",
  GITHUB_APP_ID: "1",
  GITHUB_APP_CLIENT_ID: "Iv23.app-client",
  GITHUB_APP_CLIENT_SECRET: "app-client-secret",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
  ENCRYPTION_KEY: key,
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-32-chars!",
  DATABASE_URL: "sqlite::memory:",
};
const config = loadConfig(env);
const BASE = "https://rr.example";
const DEEP_LINK = "/github.com/mdn/content/pull/45377?doc=files%2Fen-us%2Findex.md&thread=123#rr-thread-123";

// GitHub stub: each test can swap what the token endpoint answers.
const tokens = { access: "ghu_accessToken1", refresh: "ghr_refreshToken1" };
const firstTokens = () => ({
  access_token: tokens.access,
  token_type: "bearer",
  scope: "",
  expires_in: 28800,
  refresh_token: tokens.refresh,
  refresh_token_expires_in: 15897600,
});
let tokenReply: (body: URLSearchParams) => object = firstTokens;
const tokenRequests: URLSearchParams[] = [];

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (request.url === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(await request.text());
      tokenRequests.push(body);
      return json(tokenReply(body));
    }
    if (request.url === "https://api.github.com/user") {
      return json({
        id: 583231,
        login: "octocat",
        name: "The Octocat",
        email: null,
        avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
      });
    }
    // A GitHub App without the email permission cannot list emails.
    if (request.url === "https://api.github.com/user/emails") return json({ message: "Not Found" }, 404);
    throw new Error(`unexpected fetch ${request.url}`);
  });
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  tokenRequests.length = 0;
  tokenReply = firstTokens;
  vi.useRealTimers();
});

const cookieHeader = (setCookies: string[]) => setCookies.map((c) => c.split(";")[0]).join("; ");

async function signIn(identity: Identity, callbackURL: string, base = BASE) {
  const start = await identity.handle(
    new Request(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  const callback = await identity.handle(
    new Request(`${base}/api/auth/callback/github?code=the-code&state=${state}`, {
      headers: { cookie: cookieHeader(start.headers.getSetCookie()) },
    }),
  );
  return { authorizeUrl: new URL(url), callback, cookie: cookieHeader(callback.headers.getSetCookie()) };
}

const viewer = async (identity: Identity, cookie?: string) => {
  const response = await identity.handle(new Request(`${BASE}/api/auth/viewer`, { headers: cookie ? { cookie } : {} }));
  return { response, body: await response.json() };
};

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
      const schema = `rr_identity_${crypto.randomUUID().replaceAll("-", "")}`;
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

describe("authEnabled", () => {
  it("is on only with GitHub App credentials and a database on github.com", () => {
    expect(authEnabled(config, true)).toBe(true);
    expect(authEnabled(config, false)).toBe(false);
    expect(authEnabled(loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" }), true)).toBe(false);
  });
});

describe.each(databases)("GitHub sign-in on %s", (_, open) => {
  let db: SqlDatabase;
  let close: () => Promise<void>;
  let identity: Identity;

  beforeAll(async () => {
    ({ db, close } = await open());
    await migrate(db);
  });
  afterAll(() => close?.());
  beforeEach(async () => {
    for (const table of ["session", "account", "verification", "user"]) await db.run(`DELETE FROM "${table}"`);
    identity = await createIdentity({ config, db, baseURL: BASE });
  });

  it("authorizes with the GitHub App client and returns to the exact deep link", async () => {
    const { authorizeUrl, callback } = await signIn(identity, DEEP_LINK);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("Iv23.app-client");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(DEEP_LINK);
    expect(callback.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses to redirect off-site after sign-in", async () => {
    for (const callbackURL of ["https://evil.example/pwn", "//evil.example/pwn"]) {
      const response = await identity.handle(
        new Request(`${BASE}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { origin: BASE, "content-type": "application/json" },
          body: JSON.stringify({ provider: "github", callbackURL }),
        }),
      );
      expect(response.status, callbackURL).toBe(403);
    }
  });

  it("sets an HttpOnly, Secure, SameSite=Lax session cookie", async () => {
    const { callback } = await signIn(identity, "/");
    const session = callback.headers.getSetCookie().find((c) => c.includes("session_token="));
    expect(session).toMatch(/; HttpOnly/i);
    expect(session).toMatch(/; Secure/i);
    expect(session).toMatch(/; SameSite=Lax/i);
  });

  it("drops Secure only for localhost development", async () => {
    const local = await createIdentity({ config, db, baseURL: "http://localhost:3000" });
    const { callback } = await signIn(local, "/", "http://localhost:3000");
    const session = callback.headers.getSetCookie().find((c) => c.includes("session_token="));
    expect(session).toMatch(/; HttpOnly/i);
    expect(session).not.toMatch(/; Secure/i);
  });

  it("shows the signed-in viewer by GitHub login and avatar, and nothing else", async () => {
    expect((await viewer(identity)).body).toBeNull();
    const { cookie } = await signIn(identity, "/");
    const { response, body } = await viewer(identity, cookie);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" });
  });

  it("stores GitHub tokens only as ciphertext", async () => {
    await signIn(identity, "/");
    const rows = await db.all<Record<string, string | null>>(`SELECT * FROM "account"`);
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(tokens.access);
    expect(dump).not.toContain(tokens.refresh);
    const cipher = await createTokenCipher(key);
    expect(await cipher.decrypt(rows[0]!.accessToken!)).toBe(tokens.access);
    expect(await cipher.decrypt(rows[0]!.refreshToken!)).toBe(tokens.refresh);
  });

  it("never hands a GitHub token or session token to the browser", async () => {
    const { cookie } = await signIn(identity, "/");
    for (const path of [
      "get-session",
      "list-sessions",
      "list-accounts",
      "account-info",
      "get-access-token",
      "refresh-token",
    ]) {
      for (const method of ["GET", "POST"]) {
        const response = await identity.handle(
          new Request(`${BASE}/api/auth/${path}`, {
            method,
            headers: { cookie, origin: BASE, "content-type": "application/json" },
            body: method === "POST" ? "{}" : undefined,
          }),
        );
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it("rejects cross-site sign-out (CSRF) and signs out same-site", async () => {
    const { cookie } = await signIn(identity, "/");
    const signOut = (origin: string) =>
      identity.handle(
        new Request(`${BASE}/api/auth/sign-out`, {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: "{}",
        }),
      );
    expect((await signOut("https://evil.example")).status).toBe(403);
    expect((await viewer(identity, cookie)).body).not.toBeNull();
    expect((await signOut(BASE)).status).toBe(200);
    expect((await viewer(identity, cookie)).body).toBeNull();
  });

  describe("getUserGitHubToken", () => {
    const userId = async () => (await db.all<{ id: string }>(`SELECT "id" FROM "user"`))[0]!.id;

    it("returns the stored token while it is fresh, without calling GitHub", async () => {
      await signIn(identity, "/");
      tokenRequests.length = 0;
      expect(await identity.getUserGitHubToken(await userId(), "github.com")).toBe(tokens.access);
      expect(tokenRequests).toEqual([]);
    });

    it("returns null for a user without a GitHub account on that host", async () => {
      await signIn(identity, "/");
      expect(await identity.getUserGitHubToken("nobody", "github.com")).toBeNull();
      expect(await identity.getUserGitHubToken(await userId(), "ghe.example.com")).toBeNull();
    });

    it("refreshes a token near expiry once, and stores the new pair encrypted", async () => {
      await signIn(identity, "/");
      // Eight hours later the user token has expired.
      vi.useFakeTimers({ now: Date.now() + 28800 * 1000, toFake: ["Date"] });
      tokenRequests.length = 0;
      tokenReply = () => ({
        access_token: "ghu_accessToken2",
        token_type: "bearer",
        expires_in: 28800,
        refresh_token: "ghr_refreshToken2",
        refresh_token_expires_in: 15897600,
      });
      const id = await userId();
      const results = await Promise.all([
        identity.getUserGitHubToken(id, "github.com"),
        identity.getUserGitHubToken(id, "github.com"),
      ]);
      expect(results).toEqual(["ghu_accessToken2", "ghu_accessToken2"]);
      expect(tokenRequests).toHaveLength(1);
      expect(Object.fromEntries(tokenRequests[0]!)).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
        client_id: "Iv23.app-client",
        client_secret: "app-client-secret",
      });
      const [row] = await db.all<{ accessToken: string; refreshToken: string }>(
        `SELECT "accessToken", "refreshToken" FROM "account"`,
      );
      expect(JSON.stringify(row)).not.toMatch(/ghu_|ghr_/);
      const cipher = await createTokenCipher(key);
      expect(await cipher.decrypt(row!.accessToken)).toBe("ghu_accessToken2");
      expect(await cipher.decrypt(row!.refreshToken)).toBe("ghr_refreshToken2");
      // The new token is now fresh.
      expect(await identity.getUserGitHubToken(id, "github.com")).toBe("ghu_accessToken2");
      expect(tokenRequests).toHaveLength(1);
    });

    it("returns null when GitHub rejects the refresh token, so the user signs in again", async () => {
      await signIn(identity, "/");
      vi.useFakeTimers({ now: Date.now() + 28800 * 1000, toFake: ["Date"] });
      tokenReply = () => ({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect." });
      expect(await identity.getUserGitHubToken(await userId(), "github.com")).toBeNull();
    });

    it("still decrypts after key rotation and re-encrypts with the new key on refresh", async () => {
      await signIn(identity, "/");
      const newKey = btoa("n".repeat(32));
      const rotated = await createIdentity({
        config: { ...config, encryptionKey: newKey, previousEncryptionKey: key },
        db,
        baseURL: BASE,
      });
      const id = await userId();
      expect(await rotated.getUserGitHubToken(id, "github.com")).toBe(tokens.access);
      vi.useFakeTimers({ now: Date.now() + 28800 * 1000, toFake: ["Date"] });
      tokenReply = () => ({ access_token: "ghu_accessToken3", expires_in: 28800, refresh_token: "ghr_refreshToken3" });
      expect(await rotated.getUserGitHubToken(id, "github.com")).toBe("ghu_accessToken3");
      const [row] = await db.all<{ accessToken: string }>(`SELECT "accessToken" FROM "account"`);
      expect(await (await createTokenCipher(newKey)).decrypt(row!.accessToken)).toBe("ghu_accessToken3");
    });
  });
});
