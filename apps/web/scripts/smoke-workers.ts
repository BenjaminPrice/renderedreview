// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for the built Worker (run after `pnpm build:workers`): serves it in local workerd via
// `wrangler dev`, which needs no Cloudflare account. Two runs: public-only (no GitHub App: health,
// home, PR routes, sign-in off), then with fake GitHub App credentials and a fresh local D1 (sign-in on).
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCsp } from "./check-csp.ts";

const wrangler = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
const cwd = new URL("..", import.meta.url);
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

/** Serves the build with `wrangler dev <args>`, waits for /health, runs `checks` against its origin, then stops it. */
async function serve(args: string[], checks: (origin: string) => Promise<void>) {
  const port = String(8800 + Math.floor(Math.random() * 800));
  const origin = `http://127.0.0.1:${port}`;
  // `wrangler dev` finds the build output through .wrangler/deploy/config.json, written by the build.
  const child = spawn(process.execPath, [wrangler, "dev", "--port", port, "--ip", "127.0.0.1", ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100 && !response && child.exitCode === null; attempt++) {
      response = await fetch(`${origin}/health`).catch(() => undefined);
      if (!response) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(response, `worker did not answer on port ${port}:\n${output}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    console.log("ok: /health");
    await checks(origin);
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    // Negative PID: stop wrangler and the workerd process it started.
    process.kill(-child.pid!);
  }
}

// 1. Public-only, as preview runs.
await serve([], async (origin) => {
  const home = await fetch(`${origin}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type") ?? "", /text\/html/);
  console.log("ok: / renders");
  await checkCsp(`${origin}/`);

  const pr = await fetch(`${origin}/github.com/octocat/hello-world/pull/1`);
  assert.equal(pr.status, 200);
  assert.match(await pr.text(), /<title>octocat\/hello-world#1 · Rendered Review<\/title>/);
  console.log("ok: public PR route renders");

  // No GitHub App configured: sign-in is off and its routes do not exist.
  const auth = await fetch(`${origin}/api/auth/viewer`);
  assert.equal(auth.status, 404);
  console.log("ok: /api/auth is off without GitHub App credentials");
  const userRead = await fetch(`${origin}/api/github/user/github.com/repos/octocat/hello-world/pulls/1`, {
    headers: { "x-requested-with": "rendered-review" },
  });
  assert.equal(userRead.status, 404);
  console.log("ok: authenticated GitHub reads are off without sign-in");

  const sw = await fetch(`${origin}/sw.js`);
  assert.equal(sw.status, 200);
  console.log("ok: /sw.js served from static assets");
});

// 2. With the sign-in secrets production requires. Obviously fake values, passed as --var to this
// process only (never written to .dev.vars); the D1 state lives in a throwaway directory.
const fakeApp = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_CLIENT_ID: "Iv23.smoke-fake",
  GITHUB_APP_CLIENT_SECRET: "smoke-fake-client-secret",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nsmoke-fake\n-----END RSA PRIVATE KEY-----",
  GITHUB_APP_WEBHOOK_SECRET: "smoke-fake-webhook-secret",
  ENCRYPTION_KEY: btoa("smoke-fake-encryption-key-32byte"),
  BETTER_AUTH_SECRET: "smoke-fake-better-auth-secret-32-characters",
};
const state = mkdtempSync(join(tmpdir(), "rr-smoke-d1-"));
try {
  execFileSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", state], {
    cwd,
    env,
    stdio: "inherit",
  });
  const vars = Object.entries(fakeApp).flatMap(([name, value]) => ["--var", `${name}:${value}`]);
  await serve([...vars, "--persist-to", state], async (origin) => {
    const viewer = await fetch(`${origin}/api/auth/viewer`);
    assert.equal(viewer.status, 200);
    assert.equal(await viewer.json(), null);
    console.log("ok: /api/auth/viewer answers signed out when the GitHub App is configured");

    // What the Sign in button does. Better Auth stores the OAuth state in D1 and answers with GitHub's URL.
    const start = await fetch(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "github", callbackURL: "/github.com/octocat/hello-world/pull/1" }),
    });
    const body = await start.text();
    assert.equal(start.status, 200, body);
    const url = new URL((JSON.parse(body) as { url: string }).url);
    assert.equal(`${url.origin}${url.pathname}`, "https://github.com/login/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), fakeApp.GITHUB_APP_CLIENT_ID);
    assert.equal(url.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/github`);
    console.log("ok: sign-in starts at GitHub with this origin's callback URL");
  });
} finally {
  rmSync(state, { recursive: true, force: true });
}
