// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for the built Node server (run after `pnpm build`):
// it answers /health on PORT, and refuses to start with an invalid config.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import { checkCsp } from "./check-csp.ts";
import { checkRenderWorker } from "./check-render-worker.ts";

const entry = new URL("../.output/server/index.mjs", import.meta.url);
const port = String(3100 + Math.floor(Math.random() * 800));
// Keep PATH etc. but drop any app config from the caller's shell.
const base = { ...process.env, HOSTING_MODE: "", ACCESS_POLICY: "", ACCESS_ALLOWLIST: "" };

function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [entry.pathname], {
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return { child, output: () => output };
}

// 1. Valid config: serves /health on PORT.
const server = start({
  PORT: port,
  HOSTING_MODE: "community",
  ACCESS_POLICY: "disabled",
  RATE_LIMIT_GUEST_PER_MINUTE: "3",
  // Pinning the origin rebuilds each request: the client address must survive that.
  PUBLIC_URL: `http://localhost:${port}`,
});
try {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 50 && !response; attempt++) {
    response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
    if (!response) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(response, `server did not answer on port ${port}:\n${server.output()}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  console.log(`ok: /health answered on PORT=${port}`);

  await checkCsp(`http://127.0.0.1:${port}/`);
  await checkRenderWorker(new URL("../.output/public/assets/", import.meta.url));

  // Not-found page states carry a 404 status, not 200.
  for (const path of ["/github.com/o/r/pull/not-a-number", "/gitlab.example.com/o/r/pull/1"]) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 404, path);
  }
  console.log("ok: invalid and unsupported-host PR links answer 404");

  const webhook = await fetch(`http://127.0.0.1:${port}/api/github/webhook`, { method: "POST" });
  assert.equal(webhook.status, 404);
  console.log("ok: the webhook endpoint is off without a webhook secret");

  // Guest reads are limited per socket address: a spoofed X-Forwarded-For does not reset the count.
  const guest = (i: number) =>
    fetch(`http://127.0.0.1:${port}/api/github/public/github.com/not-allowed`, {
      headers: { "x-forwarded-for": `203.0.113.${i}` },
    });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await guest(i)).status);
  assert.deepEqual(statuses, [403, 403, 403, 429]);
  // Another peer address (IPv6 loopback) has its own budget.
  const other = await fetch(`http://[::1]:${port}/api/github/public/github.com/not-allowed`);
  assert.equal(other.status, 403);
  console.log("ok: the guest proxy is rate limited per client address");
} finally {
  server.child.kill();
}

// 2. Invalid config: exits non-zero with a readable message before serving.
const broken = start({ PORT: port });
const [code] = await once(broken.child, "exit");
assert.equal(code, 1);
assert.match(broken.output(), /Invalid configuration:\n {2}- HOSTING_MODE is required/);
console.log("ok: missing HOSTING_MODE stops startup with a readable error");
