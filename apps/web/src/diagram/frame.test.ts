// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from "vitest";
import { MERMAID_FRAME_PATH, mermaidFrameResponse, RENDERER_FRAME_PATH, rendererFrameResponse } from "./frame";

const frame = (script: string | null) =>
  mermaidFrameResponse(
    new Request(
      `https://rr.example${MERMAID_FRAME_PATH}${script === null ? "" : `?script=${encodeURIComponent(script)}`}`,
    ),
    "n0nce",
  );

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(policy.split(/;\s*/).map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
}

it("serves the renderer page sandboxed, with no network access", async () => {
  const response = frame("/assets/mermaid.min-Ab_1.js");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const csp = directives(response.headers.get("content-security-policy")!);
  // Opaque origin even when opened directly: no cookies, storage or same-origin access.
  expect(csp["sandbox"]).toEqual(["allow-scripts"]);
  expect(csp["default-src"]).toEqual(["'none'"]);
  expect(csp["script-src"]).toEqual(["'nonce-n0nce'"]);
  // Mermaid styles its SVG with inline <style>; nothing else may load.
  expect(csp["style-src"]).toEqual(["'unsafe-inline'"]);
  expect(csp["frame-ancestors"]).toEqual(["'self'"]);
  expect(csp["base-uri"]).toEqual(["'none'"]);
  expect(csp["form-action"]).toEqual(["'none'"]);
  expect(Object.keys(csp)).not.toContain("connect-src");
  const html = await response.text();
  expect(html).toContain('<script nonce="n0nce" src="/assets/mermaid.min-Ab_1.js"></script>');
  expect(html.match(/<script nonce="n0nce">/g)).toHaveLength(1);
  expect(html.match(/<script/g)).toHaveLength(2);
});

it("accepts the development server's module path", () => {
  expect(frame("/@fs/home/me/node_modules/.pnpm/mermaid@12.0.0/node_modules/mermaid/dist/mermaid.min.js").status).toBe(
    200,
  );
});

it.each([
  null,
  "https://evil.example/x.js",
  "//evil.example/x.js",
  '/x.js"><script>alert(1)</script>',
  "/a/../x.css",
  "javascript:alert(1)",
  "/a/../x.js",
  "/./x.js",
  "/a/./x.js",
  "/a/..",
  "/a/%2e%2e/x.js",
  "/a/%2E%2E/x.js",
])("refuses script %s", (script) => {
  expect(frame(script).status).toBe(400);
});

it("hosts bundled renderers in a Worker, allowing WebAssembly but no network", async () => {
  const response = rendererFrameResponse(new Request(`https://rr.example${RENDERER_FRAME_PATH}`), "n0nce");
  expect(response.status).toBe(200);
  const csp = directives(response.headers.get("content-security-policy")!);
  expect(csp["sandbox"]).toEqual(["allow-scripts"]);
  expect(csp["default-src"]).toEqual(["'none'"]);
  // WebAssembly compilation only: no string-to-code evaluation.
  expect(csp["script-src"]).toEqual(["'nonce-n0nce'", "'wasm-unsafe-eval'"]);
  // The Worker runs the renderer script the page hands over, from a blob URL made in the frame.
  expect(csp["worker-src"]).toEqual(["blob:"]);
  expect(csp["frame-ancestors"]).toEqual(["'self'"]);
  expect(Object.keys(csp)).not.toContain("connect-src");
  const html = await response.text();
  // Only the host script: the renderer itself never runs in the frame's own thread.
  expect(html.match(/<script/g)).toHaveLength(1);
  expect(html).toMatch(/<script nonce="n0nce">[^<]*new Worker[^<]*<\/script>/);
});
