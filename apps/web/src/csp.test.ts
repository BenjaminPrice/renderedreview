// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig } from "@rendered-review/runtime";
import { expect, test } from "vitest";
import { contentSecurityPolicy, createNonce } from "./csp";

const config = (url?: string) => loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled", GITHUB_URL: url });

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
}

test("github.com policy blocks inline scripts and unapproved origins", () => {
  const csp = directives(contentSecurityPolicy(config(), "abc"));
  expect(csp["script-src"]).toEqual(["'self'", "'nonce-abc'"]);
  expect(csp["style-src"]).toEqual(["'self'", "'nonce-abc'"]);
  expect(csp["img-src"]).toEqual(["'self'", "https://github.com", "https://*.githubusercontent.com"]);
  expect(csp["connect-src"]).toEqual([
    "'self'",
    "https://api.github.com",
    "https://github.com",
    "https://*.githubusercontent.com",
  ]);
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
