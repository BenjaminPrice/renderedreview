// SPDX-License-Identifier: AGPL-3.0-only
// The page Mermaid runs in: an application-controlled frame with its own strict policy. Its
// `sandbox` CSP directive gives it an opaque origin even when opened directly, so the renderer
// can never reach the app's cookies, storage or DOM; `default-src 'none'` stops all network
// access except the renderer script itself. The parent posts `{ id, source, theme }` and gets
// `{ id, svg }` or `{ id, error }` back; `{ ready: true }` announces the frame (`false`: the
// renderer script did not load).
//
// The frame is a server route rather than `srcdoc`: a srcdoc document inherits the app's CSP,
// which forbids the inline <style> Mermaid puts in its SVG.
import { createNonce } from "../csp";

export const MERMAID_FRAME_PATH = "/frames/mermaid";

// Same-origin build asset or dev-server path; nothing that could break out of the attribute.
const SCRIPT_PATH = /^\/(?!\/)[\w@.+/-]+\.js$/;

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

export function mermaidFrameResponse(request: Request, nonce = createNonce()): Response {
  const script = new URL(request.url).searchParams.get("script") ?? "";
  if (!SCRIPT_PATH.test(script)) return new Response("Bad renderer script", { status: 400 });
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Diagram renderer</title><script nonce="${nonce}" src="${script}"></script></head><body><script nonce="${nonce}">${BOOTSTRAP}</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
    },
  });
}
