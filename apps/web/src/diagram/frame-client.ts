// SPDX-License-Identifier: AGPL-3.0-only
// The page's side of a sandboxed renderer frame (see ./frame.ts). The frame is created on first
// use and reused for every diagram of its format. The page posts `{ id, source, theme }` and gets
// `{ id, svg }` or `{ id, error }` back; `{ ready }` announces whether the renderer loaded. SVG
// from the frame is sanitized here before display.
import type { DiagramRenderer } from "@rendered-review/diagram-domain";
import { sanitizeSvg } from "./sanitize";

type Reply = { id: number; svg: string } | { id: number; error: string };

export interface FrameRenderer {
  renderer: DiagramRenderer;
  /** Opens the frame and waits for the renderer to load, so load time never counts against a render. */
  load(): Promise<DiagramRenderer>;
  /** Removes the frame (it is recreated on the next render); outstanding renders fail. */
  close(): void;
}

export function frameRenderer(options: {
  id: string;
  fenceNames: string[];
  version: string;
  /** Format name for errors, e.g. `Mermaid`. */
  label: string;
  /** The frame page's URL. */
  src: string;
}): FrameRenderer {
  let frame: { el: HTMLIFrameElement; ready: Promise<Window>; settle: (ok: boolean) => void } | undefined;
  let nextId = 0;
  const pending = new Map<number, (reply: Reply) => void>();

  addEventListener("message", (event: MessageEvent) => {
    if (!frame || event.source !== frame.el.contentWindow) return;
    const data = event.data as { ready?: boolean } & Partial<Reply>;
    if (typeof data?.ready === "boolean") frame.settle(data.ready);
    else if (typeof data?.id === "number") pending.get(data.id)?.(data as Reply);
  });

  function close() {
    frame?.el.remove();
    frame = undefined;
    for (const [id, answer] of pending) answer({ id, error: "The diagram renderer was restarted" });
    pending.clear();
  }

  function open(): Promise<Window> {
    if (frame) return frame.ready;
    const el = document.createElement("iframe");
    el.setAttribute("sandbox", "allow-scripts");
    el.src = options.src;
    el.title = "Diagram renderer";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    // Laid out (renderers may measure text) but off screen and invisible.
    el.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden";
    let settle!: (ok: boolean) => void;
    const ready = new Promise<Window>((resolve, reject) => {
      settle = (ok) => {
        if (ok) resolve(el.contentWindow!);
        else {
          close();
          reject(new Error(`Could not load the ${options.label} renderer`));
        }
      };
    });
    frame = { el, ready, settle };
    document.body.append(el);
    return ready;
  }

  const renderer: DiagramRenderer = {
    id: options.id,
    fenceNames: options.fenceNames,
    version: options.version,
    async render({ source, theme, signal }) {
      const win = await open();
      signal.throwIfAborted();
      const id = ++nextId;
      const reply = new Promise<Reply>((resolve) => pending.set(id, resolve));
      const onAbort = () => {
        pending.delete(id);
        // A render that ran out of time may still be spinning; only a new frame gets rid of it.
        if ((signal.reason as Error | undefined)?.name === "TimeoutError") close();
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

  return {
    renderer,
    load: async () => {
      await open();
      return renderer;
    },
    close,
  };
}
