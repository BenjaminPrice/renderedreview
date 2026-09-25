// SPDX-License-Identifier: AGPL-3.0-only
// Content Security Policy for every app response. Web APIs only, so it works on any runtime.
import { githubContentOrigins } from "@rendered-review/markdown-domain";
import type { AppConfig } from "@rendered-review/runtime";
import { allowedHosts, apiBase } from "./github/proxy";

/** A fresh base64 nonce for one response. */
export function createNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * GitHub origins come from the hosts this deployment serves (github.com plus `GITHUB_URL`), so an
 * Enterprise Server deployment also allows its own host, its subdomains (raw, media, avatars)
 * and its API.
 *
 * Start stamps `nonce` on the hydration and asset scripts it renders, and on `ScriptOnce` scripts
 * such as the theme pre-paint script (__root.tsx). No other inline script runs.
 * Markdown is sanitized and may not carry scripts or styles.
 */
export function contentSecurityPolicy(config: AppConfig, nonce: string): string {
  const hosts = allowedHosts(config);
  const content = hosts.flatMap(githubContentOrigins);
  const api = hosts.map((host) => new URL(apiBase(host)).origin);
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`],
    "style-src": ["'self'", `'nonce-${nonce}'`],
    // React `style` props render as attributes. They cannot run script, url() loads are still
    // limited by img-src/font-src, and sanitized Markdown never carries them.
    "style-src-attr": ["'unsafe-inline'"],
    // blob: shows sanitized diagram SVG as images (see diagram/sanitize.ts). Only app code can
    // create blob URLs; sanitized Markdown cannot reference them.
    "img-src": ["'self'", "blob:", ...content],
    // Public blobs and metadata are fetched from the browser directly.
    "connect-src": ["'self'", ...api, ...content],
    "font-src": ["'self'"],
    // The render Worker (document/render-worker.ts) and the service worker, both same-origin.
    "worker-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(" ")}`)
    .join("; ");
}

/** `response` with the app's security headers; a response with its own policy (a diagram frame) keeps it. */
export function secureResponse(response: Response, policyHeader: string, policy: string): Response {
  // Copy, since some responses (e.g. Response.json, redirects) have immutable headers.
  const secured = new Response(response.body, response);
  if (!secured.headers.has("content-security-policy")) secured.headers.set(policyHeader, policy);
  // Following a link out (to GitHub, an external image) must not reveal the page being read.
  secured.headers.set("Referrer-Policy", "no-referrer");
  // Proxied GitHub content keeps GitHub's content type; never let a browser guess another.
  secured.headers.set("X-Content-Type-Options", "nosniff");
  return secured;
}
