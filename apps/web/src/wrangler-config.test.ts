// SPDX-License-Identifier: AGPL-3.0-only
// Guards the hosted environments in wrangler.jsonc: production declares every secret GitHub sign-in
// and commenting on public repositories need (so `wrangler deploy` refuses while one is unset),
// preview stays public-only.
import { authEnabled } from "@rendered-review/identity";
import { loadConfig } from "@rendered-review/runtime";
import { unstable_readConfig } from "wrangler";
import { expect, it } from "vitest";

const configPath = new URL("../wrangler.jsonc", import.meta.url).pathname;
const read = (env: string) => unstable_readConfig({ config: configPath, env });

// Obviously fake values that pass config validation.
const fakeSecrets: Record<string, string> = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_CLIENT_ID: "Iv23.fake",
  GITHUB_APP_CLIENT_SECRET: "fake-client-secret",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
  GITHUB_APP_WEBHOOK_SECRET: "fake-webhook-secret",
  ENCRYPTION_KEY: btoa("k".repeat(32)),
  BETTER_AUTH_SECRET: "s".repeat(32),
  GITHUB_OAUTH_CLIENT_ID: "Ov23.fake",
  GITHUB_OAUTH_CLIENT_SECRET: "fake-oauth-secret",
};

/** Sign-in state of a Worker running with this environment's vars plus the given secret names set. */
function signInWith(env: string, secretNames: string[]) {
  const { vars } = read(env);
  const secrets = Object.fromEntries(secretNames.map((name) => [name, fakeSecrets[name]]));
  const config = loadConfig({ ...(vars as Record<string, string>), ...secrets }, { databaseBinding: true });
  return authEnabled(config, true);
}

it("requires exactly the GitHub sign-in and public-commenting secrets to deploy production", () => {
  const required = read("production").secrets?.required ?? [];
  expect([...required].sort()).toEqual(Object.keys(fakeSecrets).sort());
  // Community mode with ACCESS_POLICY=disabled: those secrets alone turn sign-in on.
  expect(signInWith("production", required)).toBe(true);
});

it("keeps preview public-only, with no required secrets", () => {
  expect(read("preview").secrets).toBeUndefined();
  expect(signInWith("preview", [])).toBe(false);
});
