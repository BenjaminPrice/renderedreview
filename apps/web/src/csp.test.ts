// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig } from "@rendered-review/runtime";
import { expect, test } from "vitest";
import { contentSecurityPolicy, createNonce, secureResponse } from "./csp";

const config = (url?: string) => loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled", GITHUB_URL: url });

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
}

test("github.com policy blocks inline scripts and unapproved origins", () => {
  const csp = directives(contentSecurityPolicy(config(), "abc"));
  expect(csp["script-src"]).toEqual(["'self'", "'nonce-abc'"]);
  expect(csp["style-src"]).toEqual(["'self'", "'nonce-abc'"]);
  // blob: carries sanitized diagram SVG shown as images; only app code can mint blob URLs.
  expect(csp["img-src"]).toEqual(["'self'", "blob:", "https://github.com", "https://*.githubusercontent.com"]);
  expect(csp["connect-src"]).toEqual([
    "'self'",
    "https://api.github.com",
    "https://github.com",
    "https://*.githubusercontent.com",
  ]);
  // Same-origin Workers only (the render Worker and the service worker); never blob: or data:.
  expect(csp["worker-src"]).toEqual(["'self'"]);
  expect(csp["object-src"]).toEqual(["'none'"]);
  expect(csp["base-uri"]).toEqual(["'none'"]);
  expect(csp["frame-ancestors"]).toEqual(["'none'"]);
  const { "style-src-attr": styleAttr, ...rest } = csp;
  expect(styleAttr).toEqual(["'unsafe-inline'"]);
  expect(Object.values(rest).flat().join(" ")).not.toMatch(/unsafe|data:|\*(?!\.)|https?:(?!\/\/)/);
});

test("Enterprise Server policy adds its own host and API", () => {
  const csp = directives(contentSecurityPolicy(config("https://ghe.example.com"), "abc"));
  expect(csp["img-src"]).toEqual([
    "'self'",
    "blob:",
    "https://github.com",
    "https://*.githubusercontent.com",
    "https://ghe.example.com",
    "https://*.ghe.example.com",
  ]);
  expect(csp["connect-src"]).toEqual([
    "'self'",
    "https://api.github.com",
    "https://ghe.example.com",
    "https://github.com",
    "https://*.githubusercontent.com",
    "https://*.ghe.example.com",
  ]);
});

test("nonces are fresh 128-bit values", () => {
  const nonce = createNonce();
  expect(atob(nonce)).toHaveLength(16);
  expect(createNonce()).not.toBe(nonce);
});

test("every response gets the policy, no referrer and no MIME sniffing; a frame keeps its own policy", () => {
  const page = secureResponse(Response.json({}), "Content-Security-Policy", "default-src 'self'");
  expect(page.headers.get("content-security-policy")).toBe("default-src 'self'");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  // A proxied GitHub body must never be sniffed into HTML or script.
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");

  const frame = secureResponse(
    new Response("", { headers: { "content-security-policy": "sandbox allow-scripts" } }),
    "Content-Security-Policy",
    "default-src 'self'",
  );
  expect(frame.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  expect(frame.headers.get("x-content-type-options")).toBe("nosniff");

  // Redirects have immutable headers.
  expect(secureResponse(Response.redirect("https://app.example/"), "X", "y").headers.get("referrer-policy")).toBe(
    "no-referrer",
  );
});
