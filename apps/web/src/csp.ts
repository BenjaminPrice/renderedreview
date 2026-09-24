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
    "img-src": ["'self'", ...content],
    // Public blobs and metadata are fetched from the browser directly.
    "connect-src": ["'self'", ...api, ...content],
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
