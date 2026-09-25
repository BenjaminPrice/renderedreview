// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in with GitHub (a GitHub App's user authorization) through Better Auth. Web Platform APIs
// only, so the same code runs on Node and Workers; the runtime supplies the SqlDatabase.
import { betterAuth } from "better-auth/minimal";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { type AppConfig, log, readBodyCapped, type SqlDatabase } from "@rendered-review/runtime";
import { sqlAdapter } from "./sql-adapter";
import { createTokenCipher } from "./token-cipher";

export interface Viewer {
  login: string;
  /** GitHub's numeric user id: the stable identity, unlike the login, for "is this my comment". Absent without a GitHub account row. */
  id?: number;
  avatarUrl: string | null;
  /** Whether the OAuth App for commenting on public repositories is linked. Absent when not configured. */
  publicComments?: "linked" | "unlinked";
}

export interface SessionUser {
  /** Internal user ID: pass to `getUserGitHubToken`. Never sent to the browser. */
  id: string;
  login: string;
  avatarUrl: string | null;
}

export interface Identity {
  /**
   * Serves `/api/auth/*`: Better Auth's sign-in, callback and sign-out, linking the OAuth App
   * (`POST /link-social` with provider `github-public`, callback `/callback/github-public`), plus
   * `GET /api/auth/viewer`.
   */
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
  /**
   * The user's OAuth App token (scope `public_repo`) for writing to public repositories where the
   * GitHub App is not installed. Null when the OAuth App is not configured or not linked, or its
   * token can no longer be refreshed. Same refresh and secrecy rules as `getUserGitHubToken`.
   */
  getUserPublicWriteToken(userId: string, host: string): Promise<string | null>;
}

// ponytail: only github.com. Better Auth's GitHub provider has github.com endpoints built in; an
// Enterprise Server host needs its own OAuth endpoints (generic OAuth provider) keyed by host.
const HOST = "github.com";
const PROVIDER = "github";
// The OAuth App, linked to a user signed in through the GitHub App (Better Auth's generic OAuth
// provider: social providers are keyed by type, so a second GitHub client needs its own ID).
const PUBLIC_PROVIDER = "github-public";
// Better Auth routes the browser may call. Everything else, notably the ones that return session or
// provider tokens (get-session, get-access-token, account-info, ...), answers 404.
const BROWSER_ROUTES = new Set(["/sign-in/social", `/callback/${PROVIDER}`, "/sign-out", "/error"]);
// Starting routes take only these fields from the browser: no extra scopes or authorization params.
const START_ROUTES: Record<string, string> = { "/sign-in/social": PROVIDER, "/link-social": PUBLIC_PROVIDER };
// Refresh this long before expiry, so a token handed out still works for the request using it.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Auth requests carry at most a provider and a callback URL; anyone can send them, signed in or not.
const MAX_BODY_BYTES = 16 * 1024;

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
  const oauth = config.github.oauth;
  if (!app || !config.authSecret || !config.encryptionKey) throw new Error("GitHub sign-in is not configured");
  const cipher = await createTokenCipher(config.encryptionKey, config.previousEncryptionKey);
  const tokenEndpoint = `${config.github.url}/login/oauth/access_token`;

  // GitHub answers a rejected refresh with 200 and an `error` field, which Better Auth's generic
  // refresh would store as an undefined token. Shared by Better Auth and getUserGitHubToken.
  const refreshWith = (client: { clientId: string; clientSecret: string }) => async (refreshToken: string) => {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
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
  };
  const refreshAccessToken = refreshWith(app);

  const auth = betterAuth({
    baseURL,
    secret: config.authSecret,
    database: sqlAdapter(db, cipher),
    telemetry: { enabled: false },
    // Off in every environment: the app limits sign-in per trusted client address in front of this
    // (its own would turn on only with NODE_ENV=production and trust a client-set X-Forwarded-For).
    rateLimit: { enabled: false },
    // Better Auth's messages and arguments can carry codes, tokens or profiles: only their level
    // is logged. Failures are logged by category in `handle`.
    logger: {
      level: "warn",
      log: (level) => log[level === "error" ? "error" : "warn"]("auth.library", { category: level }),
    },
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
    plugins: oauth
      ? [
          genericOAuth({
            config: [
              {
                providerId: PUBLIC_PROVIDER,
                clientId: oauth.clientId,
                clientSecret: oauth.clientSecret,
                authorizationUrl: `${config.github.url}/login/oauth/authorize`,
                tokenUrl: tokenEndpoint,
                // Write access to public repositories only (PR reviews, review and issue comments).
                scopes: ["public_repo"],
                disableSignUp: true,
                getUserInfo: async ({ accessToken }) => {
                  const response = await fetch(`${config.github.apiUrl}/user`, {
                    headers: { authorization: `Bearer ${accessToken}`, "user-agent": "rendered-review" },
                  });
                  if (!response.ok) return null;
                  const profile = (await response.json()) as {
                    id: number;
                    login: string;
                    email: string | null;
                    avatar_url: string;
                  };
                  return {
                    id: String(profile.id),
                    name: profile.login,
                    email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
                    image: profile.avatar_url,
                    emailVerified: false,
                  };
                },
              },
            ],
          }),
        ]
      : [],
    account: {
      accountLinking: {
        // Only the OAuth App is linked (see handle), and only to the same GitHub user (validateUserInfo):
        // the GitHub user ID is the identity, not an email that may have changed since sign-in.
        trustedProviders: [PUBLIC_PROVIDER],
        allowDifferentEmails: true,
      },
    },
    user: {
      validateUserInfo: async ({ user, source }, ctx) => {
        if (source.action !== "link-account") return;
        const accounts = await ctx.context.internalAdapter.findAccounts(String(user.id));
        const signedInAs = accounts.find((a) => a.providerId === PROVIDER)?.accountId;
        if (!signedInAs || signedInAs !== String(source.oauth?.profile?.id)) {
          return {
            error: "github_account_mismatch",
            errorDescription: "Authorize with the GitHub account you signed in with",
          };
        }
      },
    },
    advanced: {
      // Secure cookies everywhere except plain-http localhost development.
      useSecureCookies: !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname),
      // Better Auth turns origin (CSRF, callback URL) checks off when NODE_ENV=test or TEST is set.
      // Never let an environment variable switch them off.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // Sessions would otherwise store the client's IP address, read from headers a client can set.
      // Rate limits use the trusted address in the app and keep only a keyed hash of it.
      ipAddress: { disableIpTracking: true },
    },
  });

  async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
    const session = await auth.api.getSession({ headers });
    if (!session) return null;
    return { id: session.user.id, login: session.user.name, avatarUrl: session.user.image ?? null };
  }

  const refreshing = new Map<string, Promise<string | null>>();

  const getUserGitHubToken = (userId: string, host: string) => userToken(PROVIDER, refreshAccessToken, userId, host);
  const refreshPublic = oauth && refreshWith(oauth);
  const getUserPublicWriteToken = async (userId: string, host: string) =>
    refreshPublic ? userToken(PUBLIC_PROVIDER, refreshPublic, userId, host) : null;

  async function userToken(
    provider: string,
    refresh: typeof refreshAccessToken,
    userId: string,
    host: string,
  ): Promise<string | null> {
    if (host !== HOST) return null;
    const context = await auth.$context;
    const account = (await context.internalAdapter.findAccounts(userId)).find((a) => a.providerId === provider);
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
          const tokens = await refresh(account.refreshToken!);
          await context.internalAdapter.updateAccount(account.id, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? account.refreshToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? account.refreshTokenExpiresAt,
          });
          return tokens.accessToken;
        } catch (error) {
          if (error instanceof RefreshRejected) {
            log.warn("auth.failure", { category: "refresh-rejected" });
            return null;
          }
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
    if (request.body) {
      const body = await readBodyCapped(request, MAX_BODY_BYTES);
      if (!body) return new Response("Request too large", { status: 413, headers: { "cache-control": "no-store" } });
      request = new Request(request, { body });
    }
    if (path === "/viewer" && request.method === "GET") {
      const user = await getSessionUser(request.headers);
      let viewer: Viewer | null = null;
      if (user) {
        const accounts = await (await auth.$context).internalAdapter.findAccounts(user.id);
        const github = accounts.find((a) => a.providerId === PROVIDER);
        viewer = { login: user.login, ...(github && { id: Number(github.accountId) }), avatarUrl: user.avatarUrl };
        if (oauth)
          viewer.publicComments = accounts.some((a) => a.providerId === PUBLIC_PROVIDER) ? "linked" : "unlinked";
      }
      response = Response.json(viewer);
    } else if (START_ROUTES[path] && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { provider?: unknown; callbackURL?: unknown } | null;
      const provider = START_ROUTES[path];
      if (body?.provider !== provider || (provider === PUBLIC_PROVIDER && !oauth)) {
        response = new Response("Not Found", { status: 404 });
      } else {
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        const callbackURL = typeof body.callbackURL === "string" ? body.callbackURL : undefined;
        response = await auth.handler(
          new Request(request.url, { method: "POST", headers, body: JSON.stringify({ provider, callbackURL }) }),
        );
      }
    } else if (BROWSER_ROUTES.has(path) || (oauth && path === `/callback/${PUBLIC_PROVIDER}`)) {
      response = await auth.handler(request);
    } else {
      response = new Response("Not Found", { status: 404 });
    }
    logFailure(path, response);
    // Auth responses are per user: never cached, by the browser, a CDN or the service worker.
    const out = new Response(response.body, response);
    out.headers.set("cache-control", "no-store");
    return out;
  }

  return { handle, getSessionUser, getUserGitHubToken, getUserPublicWriteToken };
}

/** Logs a failed sign-in step by route and category: an error redirect's code, or the status. */
function logFailure(route: string, response: Response) {
  const location = response.headers.get("location");
  const category = location && new URL(location, "http://x").searchParams.get("error");
  if (category) log.warn("auth.failure", { route, category });
  else if (response.status >= 400 && response.status !== 404)
    log.warn("auth.failure", { route, status: response.status });
}
