// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for the built Worker (run after `pnpm build:workers`): serves it in local workerd via
// `wrangler dev`, which needs no Cloudflare account, and checks the health, home and PR routes.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { checkCsp } from "./check-csp.ts";

const port = String(8800 + Math.floor(Math.random() * 800));
const wrangler = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
// `wrangler dev` finds the build output through .wrangler/deploy/config.json, written by the build.
const child = spawn(process.execPath, [wrangler, "dev", "--port", port, "--ip", "127.0.0.1"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

try {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 100 && !response && child.exitCode === null; attempt++) {
    response = await get("/health").catch(() => undefined);
    if (!response) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(response, `worker did not answer on port ${port}:\n${output}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  console.log("ok: /health");

  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type") ?? "", /text\/html/);
  console.log("ok: / renders");
  await checkCsp(`http://127.0.0.1:${port}/`);

  const pr = await get("/github.com/octocat/hello-world/pull/1");
  assert.equal(pr.status, 200);
  assert.match(await pr.text(), /<title>octocat\/hello-world#1 · Rendered Review<\/title>/);
  console.log("ok: public PR route renders");

  // No GitHub App configured: sign-in is off and its routes do not exist.
  const auth = await get("/api/auth/viewer");
  assert.equal(auth.status, 404);
  console.log("ok: /api/auth is off without GitHub App credentials");
  const userRead = await fetch(
    `http://127.0.0.1:${port}/api/github/user/github.com/repos/octocat/hello-world/pulls/1`,
    {
      headers: { "x-requested-with": "rendered-review" },
    },
  );
  assert.equal(userRead.status, 404);
  console.log("ok: authenticated GitHub reads are off without sign-in");

  const sw = await get("/sw.js");
  assert.equal(sw.status, 200);
  console.log("ok: /sw.js served from static assets");
} finally {
  // Negative PID: stop wrangler and the workerd process it started.
  process.kill(-child.pid!);
}
