// SPDX-License-Identifier: AGPL-3.0-only
// Mermaid, run in the sandboxed renderer frame (see ./frame.ts). This module is imported only
// when a document has a `mermaid` fence. The frame loads Mermaid's self-contained browser build,
// which the page itself never executes; the SVG it returns is sanitized here before display.
import type { DiagramRenderer } from "@rendered-review/diagram-domain";
import scriptUrl from "mermaid/dist/mermaid.min.js?url";
import { version } from "mermaid/package.json";
import { sanitizeSvg } from "./sanitize";

type Reply = { id: number; svg: string } | { id: number; error: string };

interface Frame {
  el: HTMLIFrameElement;
  ready: Promise<Window>;
  settle: (ok: boolean) => void;
}

let frame: Frame | undefined;
let nextId = 0;
const pending = new Map<number, (reply: Reply) => void>();

function onMessage(event: MessageEvent) {
  if (!frame || event.source !== frame.el.contentWindow) return;
  const data = event.data as { ready?: boolean } & Partial<Reply>;
  if (typeof data?.ready === "boolean") frame.settle(data.ready);
  else if (typeof data?.id === "number") pending.get(data.id)?.(data as Reply);
}

/** The shared renderer frame, created on first use and reused for every diagram. */
function openFrame(): Promise<Window> {
  if (frame) return frame.ready;
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", "allow-scripts");
  // Served by routes/frames.mermaid.ts.
  el.src = `/frames/mermaid?script=${encodeURIComponent(scriptUrl)}`;
  el.title = "Diagram renderer";
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  // Laid out (Mermaid measures text) but off screen and invisible.
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden";
  let settle!: (ok: boolean) => void;
  const ready = new Promise<Window>((resolve, reject) => {
    settle = (ok) => {
      if (ok) resolve(el.contentWindow!);
      else {
        closeMermaidFrame();
        reject(new Error("Could not load the Mermaid renderer"));
      }
    };
  });
  frame = { el, ready, settle };
  document.body.append(el);
  return ready;
}

/** Removes the frame (it is recreated on the next render); outstanding renders fail. */
export function closeMermaidFrame() {
  frame?.el.remove();
  frame = undefined;
  for (const [id, answer] of pending) answer({ id, error: "The diagram renderer was restarted" });
  pending.clear();
}

addEventListener("message", onMessage);

export const mermaidRenderer: DiagramRenderer = {
  id: "mermaid",
  fenceNames: ["mermaid"],
  // The suffix covers this adapter's own output changes (frame config, sanitizing).
  version: `${version}+1`,
  async render({ source, theme, signal }) {
    const win = await openFrame();
    signal.throwIfAborted();
    const id = ++nextId;
    const reply = new Promise<Reply>((resolve) => pending.set(id, resolve));
    const onAbort = () => {
      pending.delete(id);
      // A render that ran out of time may still be spinning; only a new frame gets rid of it.
      if ((signal.reason as Error | undefined)?.name === "TimeoutError") closeMermaidFrame();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      win.postMessage({ id, source, theme }, "*");
      const answer = await reply;
      if ("error" in answer) throw new Error(answer.error);
      return { svg: sanitizeSvg(answer.svg) };
    } finally {
      pending.delete(id);
      signal.removeEventListener("abort", onAbort);
    }
  },
};

/** Opens the frame and waits for Mermaid to load, so load time never counts against a render. */
export async function loadMermaid(): Promise<DiagramRenderer> {
  await openFrame();
  return mermaidRenderer;
}
