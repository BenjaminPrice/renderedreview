// SPDX-License-Identifier: AGPL-3.0-only
// Server only: the round trip through installing the GitHub App. `/api/github/install?return=<path>`
// sends the user to the app's install page with the path as `state`; GitHub hands `state` back to
// the app's Setup URL (`/api/github/setup`), which returns the user there. The setup request changes
// nothing: installations are recorded from webhooks, never from its unauthenticated query.
import type { AppConfig } from "@rendered-review/runtime";
import { appJwt } from "./installation";

/** `value` as an absolute URL on `origin`, only if it is a path on that origin; else undefined. */
function sameOrigin(value: string | null, origin: string): string | undefined {
  if (!value?.startsWith("/")) return undefined;
  const url = new URL(value, origin);
  // An absolute URL in Location, so a path that normalizes to `//host` still stays on this origin.
  return url.origin === origin ? url.href : undefined;
}

const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });

export function setupRedirect(request: Request): Response {
  const url = new URL(request.url);
  return redirect(sameOrigin(url.searchParams.get("state"), url.origin) ?? `${url.origin}/`);
}

// The app's public page (`https://github.com/apps/<slug>`) per config: it only changes if the app is renamed.
const appPages = new WeakMap<AppConfig, Promise<string>>();

async function appPage(config: AppConfig, fetchFn: typeof fetch) {
  const app = config.github.app!;
  const res = await fetchFn(`${config.github.apiUrl}/app`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rendered-review",
      authorization: `Bearer ${await appJwt(app.id, app.privateKey)}`,
    },
  });
  const page = res.ok ? ((await res.json()) as { html_url?: unknown }).html_url : undefined;
  if (typeof page !== "string" || !page.startsWith(`${config.github.url}/`))
    throw new Error(`GitHub app lookup failed: HTTP ${res.status}`);
  return page;
}

export async function installRedirect(request: Request, config: AppConfig, fetchFn = fetch): Promise<Response> {
  if (!config.github.app) return new Response(null, { status: 404 });
  let page = appPages.get(config);
  if (!page) appPages.set(config, (page = appPage(config, fetchFn)));
  try {
    const target = new URL(`${await page}/installations/new`);
    const url = new URL(request.url);
    const back = sameOrigin(url.searchParams.get("return"), url.origin);
    if (back) target.searchParams.set("state", back.slice(url.origin.length));
    return redirect(target.href);
  } catch {
    appPages.delete(config);
    return new Response("Could not reach GitHub", { status: 502, headers: { "cache-control": "no-store" } });
  }
}
