// SPDX-License-Identifier: AGPL-3.0-only
// The Worker's side of the renderer protocol (see ./frame-client.ts), for renderers bundled by this
// app: each `*-frame.ts` entry calls `serveRenderer` and is built into one classic script, which
// runs in a Worker inside the sandboxed renderer frame (./frame.ts). Renders are queued, one at a
// time.
import type { DiagramTheme } from "@rendered-review/diagram-domain";

export type FrameRender = (input: { source: string; theme: DiagramTheme }) => Promise<string>;

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

// Only a Worker has `importScripts`.
const workerScope = () => ("importScripts" in globalThis ? (globalThis as unknown as WorkerScope) : undefined);

/**
 * Loads the renderer, then answers render requests. Outside a Worker (a test importing the entry)
 * it does nothing unless given a scope.
 */
export function serveRenderer(load: () => Promise<FrameRender>, scope = workerScope()): void {
  if (!scope) return;
  let queue = Promise.resolve();
  load().then(
    (render) => {
      scope.addEventListener("message", (event) => {
        const data = event.data as { id?: unknown; source?: unknown; theme?: unknown } | null;
        if (typeof data?.id !== "number" || typeof data.source !== "string") return;
        const { id, source } = data;
        const theme = data.theme === "dark" ? "dark" : "light";
        queue = queue.then(async () => {
          try {
            scope.postMessage({ id, svg: await render({ source, theme }) });
          } catch (error) {
            scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
          }
        });
      });
      scope.postMessage({ ready: true });
    },
    () => scope.postMessage({ ready: false }),
  );
}
