// SPDX-License-Identifier: AGPL-3.0-only
// The pages diagram renderers run in: application-controlled frames with their own strict policy.
// The `sandbox` CSP directive gives it an opaque origin even when opened directly, so the renderer
// can never reach the app's cookies, storage or DOM; `default-src 'none'` stops all network
// access except the renderer script itself. The parent posts `{ id, source, theme }` and gets
// `{ id, svg }` or `{ id, error }` back; `{ ready: true }` announces the frame (`false`: the
// renderer script did not load).
//
// The frame is a server route rather than `srcdoc`: a srcdoc document inherits the app's CSP,
// which forbids the inline <style> Mermaid puts in its SVG.
import { createNonce } from "../csp";

export const MERMAID_FRAME_PATH = "/frames/mermaid";
/** Renderers bundled by this app (`*-frame.ts`, see ./frame-entry.ts). */
export const RENDERER_FRAME_PATH = "/frames/renderer";

// The script path comes from the request (`?script=`): the page passes the URL Vite assigned
// Mermaid's browser build (a hashed `/assets/` file, or a dev-server path). It must be a plain
// same-origin path: safe characters only (nothing that could break out of the attribute, no `%`
// escapes) and no empty, `.` or `..` segments.
const SAFE_SEGMENT = /^[\w@.+-]+$/;
const isScriptPath = (path: string, ext = /\.js$/) =>
  path.startsWith("/") &&
  ext.test(path) &&
  path
    .slice(1)
    .split("/")
    .every((segment) => SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..");

// Runs in the frame. Renders are queued: Mermaid keeps global state while rendering.
const BOOTSTRAP = `(() => {
  if (typeof mermaid === "undefined") return parent.postMessage({ ready: false }, "*");
  const config = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    deterministicIds: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  };
  let queue = Promise.resolve();
  addEventListener("message", (event) => {
    if (event.source !== parent || typeof event.data?.source !== "string") return;
    const { id, source, theme } = event.data;
    queue = queue.then(async () => {
      try {
        mermaid.initialize({ ...config, theme: theme === "dark" ? "dark" : "default" });
        const { svg } = await mermaid.render("rr-diagram-" + id, source);
        parent.postMessage({ id, svg }, "*");
      } catch (error) {
        parent.postMessage({ id, error: String(error?.message ?? error) }, "*");
      }
    });
  });
  parent.postMessage({ ready: true }, "*");
})();`;

// The development server serves a bundled renderer's entry as a module (built, it is one classic
// script). Its modules load under the page's nonce.
const DEV_ENTRY = "?worker_file&type=module";

// Runs after the renderer script, which sets the flag as it starts and announces success itself.
const LOAD_CHECK = `if (!globalThis.rrRenderer) parent.postMessage({ ready: false }, "*");`;

export function mermaidFrameResponse(request: Request, nonce = createNonce()): Response {
  const script = new URL(request.url).searchParams.get("script") ?? "";
  if (!isScriptPath(script)) return new Response("Bad renderer script", { status: 400 });
  return frameResponse({ src: script, inline: BOOTSTRAP, nonce });
}

export function rendererFrameResponse(request: Request, nonce = createNonce()): Response {
  const script = new URL(request.url).searchParams.get("script") ?? "";
  const dev = script.endsWith(DEV_ENTRY);
  const path = dev ? script.slice(0, -DEV_ENTRY.length) : script;
  if (!isScriptPath(path, dev ? /\.ts$/ : /\.js$/)) return new Response("Bad renderer script", { status: 400 });
  const src = dev ? `${path}${DEV_ENTRY.replace("&", "&amp;")}` : path;
  // Bundled renderers include WebAssembly builds; compiling WebAssembly is all this allows.
  return frameResponse({ src, module: dev, inline: LOAD_CHECK, nonce, scriptSources: ["'wasm-unsafe-eval'"] });
}

function frameResponse(page: {
  src: string;
  module?: boolean;
  /** Runs after the renderer script. */
  inline: string;
  nonce: string;
  scriptSources?: string[];
}): Response {
  const { src, inline, nonce, scriptSources = [] } = page;
  const type = page.module ? ' type="module"' : "";
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${scriptSources.map((s) => ` ${s}`).join("")}`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
  // Module scripts run in order after parsing, so a module renderer's inline script is one too.
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Diagram renderer</title><script${type} nonce="${nonce}" src="${src}"></script></head><body><script${type} nonce="${nonce}">${inline}</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
    },
  });
}
