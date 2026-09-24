// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in with GitHub (a GitHub App's user authorization) through Better Auth. Web Platform APIs
// only, so the same code runs on Node and Workers; the runtime supplies the SqlDatabase.
import { betterAuth } from "better-auth/minimal";
import type { AppConfig, SqlDatabase } from "@rendered-review/runtime";
import { sqlAdapter } from "./sql-adapter";
import { createTokenCipher } from "./token-cipher";

export interface SessionUser {
  /** Internal user ID: pass to `getUserGitHubToken`. Never sent to the browser. */
  id: string;
  login: string;
  avatarUrl: string | null;
}

export interface Identity {
  /** Serves `/api/auth/*`: Better Auth's sign-in, callback and sign-out, plus `GET /api/auth/viewer`. */
  handle(request: Request): Promise<Response>;
  /** The signed-in user for a request's cookies, or null. */
  getSessionUser(headers: Headers): Promise<SessionUser | null>;
  /**
   * A usable GitHub user-to-server token for `host`, refreshed (and re-stored encrypted) when it is
   * expired or about to expire. Null when the user has no GitHub account there or GitHub rejected
   * the refresh token: the user has to sign in again. Network and GitHub outages throw.
   * Server-side only: the token must never reach the browser.
   */
  getUserGitHubToken(userId: string, host: string): Promise<string | null>;
}

// ponytail: only github.com. Better Auth's GitHub provider has github.com endpoints built in; an
// Enterprise Server host needs its own OAuth endpoints (generic OAuth provider) keyed by host.
const HOST = "github.com";
const PROVIDER = "github";
// Better Auth routes the browser may call. Everything else, notably the ones that return session or
// provider tokens (get-session, get-access-token, account-info, ...), answers 404.
const BROWSER_ROUTES = new Set(["/sign-in/social", `/callback/${PROVIDER}`, "/sign-out", "/error"]);
// Refresh this long before expiry, so a token handed out still works for the request using it.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Sign-in is available when the GitHub App, its secrets and a database are configured. */
export function authEnabled(config: AppConfig, hasDatabase: boolean): boolean {
  return Boolean(
    config.github.app &&
    config.authSecret &&
    config.encryptionKey &&
    hasDatabase &&
    new URL(config.github.url).host === HOST,
  );
}

class RefreshRejected extends Error {}

export async function createIdentity({
  config,
  db,
  baseURL,
}: {
  config: AppConfig;
  db: SqlDatabase;
  /** Public origin of this deployment, e.g. https://renderedreview.dev or http://localhost:3000. */
  baseURL: string;
}): Promise<Identity> {
  const app = config.github.app;
  if (!app || !config.authSecret || !config.encryptionKey) throw new Error("GitHub sign-in is not configured");
  const cipher = await createTokenCipher(config.encryptionKey, config.previousEncryptionKey);
  const tokenEndpoint = `${config.github.url}/login/oauth/access_token`;

  // GitHub answers a rejected refresh with 200 and an `error` field, which Better Auth's generic
  // refresh would store as an undefined token. Shared by Better Auth and getUserGitHubToken.
  async function refreshAccessToken(refreshToken: string) {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: app!.clientId,
        client_secret: app!.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!response.ok) throw new Error(`GitHub token refresh failed: HTTP ${response.status}`);
    const data = (await response.json()) as Record<string, string | number | undefined>;
    if (data.error || typeof data.access_token !== "string") throw new RefreshRejected(String(data.error));
    const at = (seconds: unknown) => (typeof seconds === "number" ? new Date(Date.now() + seconds * 1000) : undefined);
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      accessTokenExpiresAt: at(data.expires_in),
      refreshTokenExpiresAt: at(data.refresh_token_expires_in),
      tokenType: typeof data.token_type === "string" ? data.token_type : undefined,
      scopes: [],
    };
  }

  const auth = betterAuth({
    baseURL,
    secret: config.authSecret,
    database: sqlAdapter(db, cipher),
    telemetry: { enabled: false },
    socialProviders: {
      github: {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        // GitHub Apps ignore OAuth scopes: access comes from the app's permissions.
        disableDefaultScope: true,
        refreshAccessToken,
        // Keep login and avatar current across GitHub renames.
        overrideUserInfoOnSignIn: true,
        // `name` holds the GitHub login (what the UI shows). Without the app's email permission
        // GitHub sends no address, so fall back to the account's noreply address.
        mapProfileToUser: (profile) => ({
          name: profile.login,
          email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
        }),
      },
    },
    advanced: {
      // Secure cookies everywhere except plain-http localhost development.
      useSecureCookies: !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname),
      // Better Auth turns origin (CSRF, callback URL) checks off when NODE_ENV=test or TEST is set.
      // Never let an environment variable switch them off.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
  });

  async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
    const session = await auth.api.getSession({ headers });
    if (!session) return null;
    return { id: session.user.id, login: session.user.name, avatarUrl: session.user.image ?? null };
  }

  const refreshing = new Map<string, Promise<string | null>>();

  async function getUserGitHubToken(userId: string, host: string): Promise<string | null> {
    if (host !== HOST) return null;
    const context = await auth.$context;
    const account = (await context.internalAdapter.findAccounts(userId)).find((a) => a.providerId === PROVIDER);
    if (!account?.accessToken) return null;
    const expiresAt = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt).getTime() : Infinity;
    if (expiresAt - Date.now() > REFRESH_MARGIN_MS) return account.accessToken;
    if (!account.refreshToken) return null;

    // GitHub refresh tokens are single-use: concurrent requests share one refresh.
    // ponytail: per process/isolate; a second instance refreshing at the same moment loses and
    // its user signs in again. Add a database lease if that shows up.
    let pending = refreshing.get(account.id);
    if (!pending) {
      pending = (async () => {
        try {
          const tokens = await refreshAccessToken(account.refreshToken!);
          await context.internalAdapter.updateAccount(account.id, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? account.refreshToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? account.refreshTokenExpiresAt,
          });
          return tokens.accessToken;
        } catch (error) {
          if (error instanceof RefreshRejected) return null;
          throw error;
        } finally {
          refreshing.delete(account.id);
        }
      })();
      refreshing.set(account.id, pending);
    }
    return pending;
  }

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
    let response: Response;
    if (path === "/viewer" && request.method === "GET") {
      const user = await getSessionUser(request.headers);
      response = Response.json(user && { login: user.login, avatarUrl: user.avatarUrl });
    } else if (BROWSER_ROUTES.has(path)) {
      response = await auth.handler(request);
    } else {
      response = new Response("Not Found", { status: 404 });
    }
    // Auth responses are per user: never cached, by the browser, a CDN or the service worker.
    const out = new Response(response.body, response);
    out.headers.set("cache-control", "no-store");
    return out;
  }

  return { handle, getSessionUser, getUserGitHubToken };
}
