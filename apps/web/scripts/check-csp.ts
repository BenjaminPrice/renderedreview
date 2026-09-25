// SPDX-License-Identifier: AGPL-3.0-only
// Shared by the Node and Workers smoke tests: the page carries the CSP, every script Start renders
// carries this response's nonce, the nonce changes per response, and no referrer is sent.
import assert from "node:assert/strict";

const nonceOf = (response: Response) =>
  /'nonce-([^']+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];

export async function checkCsp(url: string): Promise<void> {
  const page = await fetch(url);
  const csp = page.headers.get("content-security-policy") ?? "";
  const nonce = nonceOf(page);
  assert.ok(nonce, `no script nonce in CSP: ${csp}`);
  assert.match(csp, /script-src 'self' 'nonce-[^';]+';/);
  for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), `CSP lacks ${directive}: ${csp}`);
  }
  assert.match(csp, /(^|;\s*)worker-src 'self'\s*(;|$)/, `CSP should allow only same-origin Workers: ${csp}`);
  // Links out (GitHub, external images) must not reveal which PR the reader was viewing.
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  const scripts = (await page.text()).match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scripts.length > 0, "page rendered no scripts");
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), `script without nonce: ${tag}`);
  assert.notEqual(nonceOf(await fetch(url)), nonce, "nonce reused across responses");
  console.log(`ok: ${new URL(url).pathname} sends the CSP and nonces all ${scripts.length} scripts`);

  // The diagram renderer frame keeps its own, stricter policy instead of the app's.
  const frame = await fetch(new URL("/frames/mermaid?script=/assets/mermaid.js", url));
  const framePolicy = frame.headers.get("content-security-policy") ?? "";
  for (const directive of ["sandbox allow-scripts", "default-src 'none'", "frame-ancestors 'self'"]) {
    assert.ok(framePolicy.includes(directive), `frame CSP lacks ${directive}: ${framePolicy}`);
  }
  assert.ok(!frame.headers.has("content-security-policy-report-only"), "frame also got the app policy");
  console.log("ok: /frames/mermaid sends its own sandboxing CSP");
}
