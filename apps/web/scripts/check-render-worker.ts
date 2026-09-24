// SPDX-License-Identifier: AGPL-3.0-only
// Shared by the Node and Workers smoke tests: the built render Worker runs in a Worker-like
// global scope (no DOM) and answers a render request.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export async function checkRenderWorker(assets: URL): Promise<void> {
  const file = readdirSync(assets).find((name) => /^render-worker-.*\.js$/.test(name));
  assert.ok(file, `no render-worker bundle in ${assets.pathname}`);
  const reply = new Promise<{ id: number; rendered?: { nodes: { type: string }[] }; error?: string }>(
    (resolve, reject) => {
      const self: Record<string, unknown> = { postMessage: resolve };
      self.self = self;
      const { URL, URLSearchParams, TextEncoder, TextDecoder, console, structuredClone } = globalThis;
      try {
        runInNewContext(readFileSync(new URL(file, assets), "utf8"), {
          ...{ self, URL, URLSearchParams, TextEncoder, TextDecoder, console, structuredClone },
          postMessage: resolve,
        });
      } catch (error) {
        reject(new Error(`${file} failed to start: ${String(error)}`));
        return;
      }
      const job = { source: "# Title\n\nA &amp; B\n", pr: { host: "github.com", owner: "o", repo: "r", number: 1 }, sha: "s", path: "a.md" };
      (self.onmessage as (event: { data: unknown }) => void)({ data: { id: 1, job } });
    },
  );
  const answer = await reply;
  assert.equal(answer.id, 1);
  assert.equal(answer.error, undefined);
  assert.equal(answer.rendered?.nodes[0]?.type, "heading");
  console.log(`ok: ${file} renders without a DOM`);
}
