// SPDX-License-Identifier: AGPL-3.0-only
// Server-side GitHub request metrics: one `github.request` log event per upstream call, with the
// route as a template so owner, repository, file paths and numbers never reach the logs (a
// private repository's name is itself confidential). Web fetch only.
import { errorName, log } from "@rendered-review/runtime";

// Endpoint words kept verbatim; every other segment becomes `:`.
const LITERAL = new Set([
  "access_token",
  "blobs",
  "comments",
  "files",
  "git",
  "graphql",
  "installation",
  "installations",
  "issues",
  "login",
  "oauth",
  "pulls",
  "replies",
  "reviews",
  "trees",
  "user",
]);

/** `https://api.github.com/repos/acme/app/pulls/1/files?page=2` -> `/repos/:/:/pulls/:/files`. */
export function githubRoute(url: string): string {
  const parts = new URL(url).pathname
    .replace(/^\/api(\/v3)?(?=\/)/, "")
    .split("/")
    .filter(Boolean);
  // Owner and repository (or repository ID) are positional, so a repository named `pulls` stays hidden.
  const fixed = parts[0] === "repos" ? 3 : parts[0] === "repositories" ? 2 : 0;
  const out = parts.slice(0, fixed).map((p, i) => (i === 0 ? p : ":"));
  for (const part of parts.slice(fixed)) {
    if (part === "contents") {
      out.push("contents", "*");
      break;
    }
    out.push(LITERAL.has(part) ? part : ":");
  }
  return `/${out.join("/")}`;
}

/** Wraps `fetchFn` so every GitHub call it makes is logged as a `github.request` event. */
export const meteredFetch =
  (fetchFn: typeof fetch): typeof fetch =>
  async (input, init) => {
    // Read without cloning: a Request body must stay unread for the real fetch.
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const fields = { host: new URL(url).host, method, route: githubRoute(url) };
    const started = performance.now();
    try {
      const res = await fetchFn(input, init);
      const remaining = res.headers.get("x-ratelimit-remaining");
      (res.status >= 400 ? log.warn : log.info)("github.request", {
        ...fields,
        status: res.status,
        durationMs: performance.now() - started,
        ...(remaining !== null && { rateLimitRemaining: Number(remaining) }),
        outcome: res.status >= 400 ? "error" : "ok",
      });
      return res;
    } catch (error) {
      log.warn("github.request", {
        ...fields,
        status: 0,
        durationMs: performance.now() - started,
        outcome: "network",
        error: errorName(error),
      });
      throw error;
    }
  };
