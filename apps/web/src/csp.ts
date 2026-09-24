// SPDX-License-Identifier: AGPL-3.0-only
// Content Security Policy for every app response. Web APIs only, so it works on any runtime.
import { githubContentOrigins } from "@rendered-review/markdown-domain";
import type { AppConfig } from "@rendered-review/runtime";

/** A fresh base64 nonce for one response. */
export function createNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * GitHub origins come from config (`GITHUB_URL`), so an Enterprise Server deployment allows its
 * own host, its subdomains (raw, media, avatars) and its API instead of github.com's.
 *
 * Start stamps `nonce` on the hydration and asset scripts it renders, so no inline script runs
 * without it. Nothing else is inline: Markdown is sanitized and may not carry scripts or styles.
 */
export function contentSecurityPolicy(github: AppConfig["github"], nonce: string): string {
  const web = new URL(github.url);
  const content = githubContentOrigins(web.host);
  const api = new URL(github.apiUrl).origin;
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`],
    "style-src": ["'self'", `'nonce-${nonce}'`],
    "img-src": ["'self'", ...content],
    // Public blobs and metadata are fetched from the browser directly.
    "connect-src": ["'self'", api, ...content],
    "font-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(" ")}`)
    .join("; ");
}
