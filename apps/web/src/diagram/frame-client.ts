// SPDX-License-Identifier: AGPL-3.0-only
// The page's side of a renderer running outside the page: in a sandboxed frame (see ./frame.ts),
// or in development in a Worker. The host is created on first use and reused for every diagram of
// its format. The page posts `{ id, source, theme }` and gets `{ id, svg }` or `{ id, error }`
// back; `{ ready }` announces whether the renderer loaded. SVG from the host is sanitized here
// before display.
import type { DiagramRenderer } from "@rendered-review/diagram-domain";
import { sanitizeSvg } from "./sanitize";

// A host that has not announced itself by then (script blocked or crashed) never will.
const LOAD_TIMEOUT_MS = 20_000;

type Reply = { id: number; svg: string } | { id: number; error: string };

/** Starts a renderer host that reports its messages to `onMessage`. */
export type Host = (onMessage: (data: unknown) => void) => { post(message: unknown): void; close(): void };

/** A sandboxed, hidden frame at `src`. `onHost` answers the frame's `{ host: true }`. */
export function frameHost(src: string, onHost?: (post: (message: unknown) => void) => void): Host {
  return (onMessage) => {
    const el = document.createElement("iframe");
    el.setAttribute("sandbox", "allow-scripts");
    el.src = src;
    el.title = "Diagram renderer";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    // Laid out (renderers may measure text) but off screen and invisible.
    el.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden";
    const post = (message: unknown) => el.contentWindow?.postMessage(message, "*");
    const listener = (event: MessageEvent) => {
      if (event.source !== el.contentWindow) return;
      if ((event.data as { host?: unknown } | null)?.host === true) onHost?.(post);
      else onMessage(event.data);
    };
    addEventListener("message", listener);
    document.body.append(el);
    return {
      post,
      close: () => {
        removeEventListener("message", listener);
        el.remove();
      },
    };
  };
}

/**
 * A renderer bundled by this app (`*-frame.ts`, given its `?worker&url` URL). Built, it runs in a
 * Worker inside the sandboxed renderer frame, which cannot fetch same-origin scripts itself, so the
 * page hands it the script's text. The development server serves the entry as modules, which only
 * a same-origin Worker can load, so there the page runs it in a Worker of its own.
 */
export function bundledHost(script: string, dev = import.meta.env.DEV): Host {
  if (!dev) {
    return (onMessage) =>
      frameHost("/frames/renderer", (post) =>
        fetch(script)
          .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
          .then(
            (text) => post({ script: text }),
            () => onMessage({ ready: false }),
          ),
      )(onMessage);
  }
  return (onMessage) => {
    const worker = new Worker(script, { type: "module" });
    worker.onmessage = (event) => onMessage(event.data);
    worker.onerror = () => onMessage({ ready: false });
    return { post: (message) => worker.postMessage(message), close: () => worker.terminate() };
  };
}

export interface FrameRenderer {
  renderer: DiagramRenderer;
  /** Starts the host and waits for the renderer to load, so load time never counts against a render. */
  load(): Promise<DiagramRenderer>;
  /** Stops the host (it is restarted on the next render); outstanding renders fail. */
  close(): void;
}

export function frameRenderer(options: {
  id: string;
  fenceNames: string[];
  version: string;
  /** Format name for errors, e.g. `Mermaid`. */
  label: string;
  host: Host;
}): FrameRenderer {
  let current: { post(message: unknown): void; close(): void; ready: Promise<void> } | undefined;
  let nextId = 0;
  const pending = new Map<number, (reply: Reply) => void>();

  function close() {
    current?.close();
    current = undefined;
    for (const [id, answer] of pending) answer({ id, error: "The diagram renderer was restarted" });
    pending.clear();
  }

  function open(): Promise<void> {
    if (current) return current.ready;
    let settle!: (ok: boolean) => void;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle(false), LOAD_TIMEOUT_MS);
      settle = (ok) => {
        clearTimeout(timer);
        if (current?.ready !== ready) return;
        if (ok) resolve();
        else {
          close();
          reject(new Error(`Could not load the ${options.label} renderer`));
        }
      };
    });
    const host = options.host((data) => {
      const message = data as ({ ready?: boolean } & Partial<Reply>) | null;
      if (typeof message?.ready === "boolean") settle(message.ready);
      else if (typeof message?.id === "number") pending.get(message.id)?.(message as Reply);
    });
    current = { ...host, ready };
    return ready;
  }

  const renderer: DiagramRenderer = {
    id: options.id,
    fenceNames: options.fenceNames,
    version: options.version,
    async render({ source, theme, signal }) {
      await open();
      signal.throwIfAborted();
      const id = ++nextId;
      const reply = new Promise<Reply>((resolve) => pending.set(id, resolve));
      const onAbort = () => {
        pending.delete(id);
        // A render that ran out of time may still be spinning; only a new host gets rid of it.
        if ((signal.reason as Error | undefined)?.name === "TimeoutError") close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        current!.post({ id, source, theme });
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
