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
/** Hosts renderers bundled by this app (`*-frame.ts`, see ./frame-entry.ts) in a Worker. */
export const RENDERER_FRAME_PATH = "/frames/renderer";

// The script path comes from the request (`?script=`): the page passes the URL Vite assigned
// Mermaid's browser build (a hashed `/assets/` file, or a dev-server path). It must be a plain
// same-origin path: safe characters only (nothing that could break out of the attribute, no `%`
// escapes) and no empty, `.` or `..` segments.
const SAFE_SEGMENT = /^[\w@.+-]+$/;
const isScriptPath = (path: string) =>
  path.startsWith("/") &&
  path.endsWith(".js") &&
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

// Runs in the renderer frame: starts a Worker from the renderer script the page posts (as text:
// the frame's opaque origin cannot load same-origin scripts into a Worker), then relays messages
// both ways. The Worker keeps heavy layouts off every page thread, and inherits this policy.
const WORKER_HOST = `(() => {
  let worker;
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    if (!worker && typeof event.data?.script === "string") {
      worker = new Worker(URL.createObjectURL(new Blob([event.data.script], { type: "text/javascript" })));
      worker.onmessage = (message) => parent.postMessage(message.data, "*");
      worker.onerror = () => parent.postMessage({ ready: false }, "*");
    } else if (worker) worker.postMessage(event.data);
  });
  parent.postMessage({ host: true }, "*");
})();`;

export function mermaidFrameResponse(request: Request, nonce = createNonce()): Response {
  const script = new URL(request.url).searchParams.get("script") ?? "";
  if (!isScriptPath(script)) return new Response("Bad renderer script", { status: 400 });
  return frameResponse({ src: script, inline: BOOTSTRAP, nonce });
}

// Bundled renderers include WebAssembly builds: compiling WebAssembly is all `wasm-unsafe-eval`
// allows. Only code in the frame can create the blob URLs `worker-src` admits.
export function rendererFrameResponse(_request: Request, nonce = createNonce()): Response {
  return frameResponse({
    inline: WORKER_HOST,
    nonce,
    scriptSources: ["'wasm-unsafe-eval'"],
    extra: ["worker-src blob:"],
  });
}

function frameResponse(page: {
  /** A renderer script for the page itself to load. */
  src?: string;
  /** Runs after it. */
  inline: string;
  nonce: string;
  scriptSources?: string[];
  extra?: string[];
}): Response {
  const { src, inline, nonce, scriptSources = [], extra = [] } = page;
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${scriptSources.map((s) => ` ${s}`).join("")}`,
    "style-src 'unsafe-inline'",
    ...extra,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
  const script = src ? `<script nonce="${nonce}" src="${src}"></script>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Diagram renderer</title>${script}</head><body><script nonce="${nonce}">${inline}</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
    },
  });
}
