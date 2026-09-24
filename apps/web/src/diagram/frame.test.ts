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

const rendererFrame = (script: string | null) =>
  rendererFrameResponse(
    new Request(
      `https://rr.example${RENDERER_FRAME_PATH}${script === null ? "" : `?script=${encodeURIComponent(script)}`}`,
    ),
    "n0nce",
  );

it("serves bundled renderers sandboxed, allowing WebAssembly but no network", async () => {
  const response = rendererFrame("/assets/graphviz-frame-Ab_1.js");
  expect(response.status).toBe(200);
  const csp = directives(response.headers.get("content-security-policy")!);
  expect(csp["sandbox"]).toEqual(["allow-scripts"]);
  expect(csp["default-src"]).toEqual(["'none'"]);
  // WebAssembly compilation only: no string-to-code evaluation.
  expect(csp["script-src"]).toEqual(["'nonce-n0nce'", "'wasm-unsafe-eval'"]);
  expect(csp["frame-ancestors"]).toEqual(["'self'"]);
  expect(Object.keys(csp)).not.toContain("connect-src");
  const html = await response.text();
  // A classic script: an opaque-origin page cannot load module scripts without CORS headers.
  expect(html).toContain('<script nonce="n0nce" src="/assets/graphviz-frame-Ab_1.js"></script>');
  // Announces a failed load, since the bundle announces only success.
  expect(html).toMatch(/<script nonce="n0nce">[^<]*ready: false[^<]*<\/script>/);
});

it("loads the development server's renderer entry as a module", async () => {
  const response = rendererFrame("/src/diagram/graphviz-frame.ts?worker_file&type=module");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(
    '<script type="module" nonce="n0nce" src="/src/diagram/graphviz-frame.ts?worker_file&amp;type=module"></script>',
  );
});

it.each([null, "https://evil.example/x.js", "/x.js?a=b", "/x.ts?worker_file&type=module&x", "/a/../x.js"])(
  "refuses renderer script %s",
  (script) => {
    expect(rendererFrame(script).status).toBe(400);
  },
);
