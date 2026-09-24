// SPDX-License-Identifier: AGPL-3.0-only
// The frame's side of the renderer protocol (see ./frame-client.ts), for renderers bundled by this
// app: each `*-frame.ts` entry calls `serveRenderer` and is built into one script the renderer
// frame (./frame.ts) loads. Renders are queued, one at a time.
import type { DiagramTheme } from "@rendered-review/diagram-domain";

export type FrameRender = (input: { source: string; theme: DiagramTheme }) => Promise<string>;

/** Loads the renderer, then answers the page. Returns a function that stops answering. */
export function serveRenderer(load: () => Promise<FrameRender>): () => void {
  // Tells the frame page's load check that this script ran.
  (globalThis as { rrRenderer?: boolean }).rrRenderer = true;
  let queue = Promise.resolve();
  const controller = new AbortController();
  load().then(
    (render) => {
      addEventListener(
        "message",
        (event: MessageEvent) => {
          const data = event.data as { id?: unknown; source?: unknown; theme?: unknown } | null;
          if (event.source !== parent || typeof data?.id !== "number" || typeof data.source !== "string") return;
          const { id, source } = data;
          const theme = data.theme === "dark" ? "dark" : "light";
          queue = queue.then(async () => {
            try {
              parent.postMessage({ id, svg: await render({ source, theme }) }, "*");
            } catch (error) {
              parent.postMessage({ id, error: error instanceof Error ? error.message : String(error) }, "*");
            }
          });
        },
        { signal: controller.signal },
      );
      parent.postMessage({ ready: true }, "*");
    },
    () => parent.postMessage({ ready: false }, "*"),
  );
  return () => controller.abort();
}
