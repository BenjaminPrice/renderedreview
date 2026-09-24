// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for the built Node server (run after `pnpm build`):
// it answers /health on PORT, and refuses to start with an invalid config.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";

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
const server = start({ PORT: port, HOSTING_MODE: "community", ACCESS_POLICY: "disabled" });
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

  // Every page carries the CSP, and every script Start renders carries its nonce.
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const csp = page.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, `no script nonce in CSP: ${csp}`);
  for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), `CSP lacks ${directive}: ${csp}`);
  }
  assert.match(csp, /script-src 'self' 'nonce-[^';]+';/);
  const scripts = (await page.text()).match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scripts.length > 0, "page rendered no scripts");
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), `script without nonce: ${tag}`);
  const again = await fetch(`http://127.0.0.1:${port}/`);
  assert.notEqual(/'nonce-([^']+)'/.exec(again.headers.get("content-security-policy") ?? "")?.[1], nonce);
  console.log(`ok: / sends the CSP and nonces all ${scripts.length} scripts`);
} finally {
  server.child.kill();
}

// 2. Invalid config: exits non-zero with a readable message before serving.
const broken = start({ PORT: port });
const [code] = await once(broken.child, "exit");
assert.equal(code, 1);
assert.match(broken.output(), /Invalid configuration:\n {2}- HOSTING_MODE is required/);
console.log("ok: missing HOSTING_MODE stops startup with a readable error");
