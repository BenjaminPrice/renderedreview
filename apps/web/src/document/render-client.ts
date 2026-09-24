// SPDX-License-Identifier: AGPL-3.0-only
// The page's side of the render Worker (./render-worker.ts). Requests carry ids; a reply is
// `{ id, rendered }` or `{ id, error }`. Aborting a request that the worker is busy with
// terminates the worker, so stale work stops at once; other requests move to a new worker.
import type { RenderedMarkdown } from "@rendered-review/markdown-domain";
import type { RenderJob } from "./render-job";
import script from "./render-worker?worker&url";

export type WorkerLike = Pick<Worker, "postMessage" | "terminate"> & {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export type RenderReply = { id: number; rendered: RenderedMarkdown } | { id: number; error: string };

interface Pending {
  job: RenderJob;
  resolve(rendered: RenderedMarkdown): void;
  reject(error: unknown): void;
}

export function renderClient(create: () => WorkerLike) {
  let worker: WorkerLike | undefined;
  let nextId = 0;
  const pending = new Map<number, Pending>();

  function start(): WorkerLike {
    const w = create();
    w.onmessage = ({ data }: MessageEvent<RenderReply>) => {
      const request = pending.get(data.id);
      pending.delete(data.id);
      if ("error" in data) request?.reject(new Error(data.error));
      else request?.resolve(data.rendered);
    };
    w.onerror = () => {
      if (worker === w) worker = undefined;
      w.terminate();
      for (const request of pending.values()) request.reject(new Error("The document renderer failed to start"));
      pending.clear();
    };
    return w;
  }

  return function render(job: RenderJob, signal: AbortSignal): Promise<RenderedMarkdown> {
    if (signal.aborted) return Promise.reject(signal.reason);
    worker ??= start();
    const id = ++nextId;
    return new Promise<RenderedMarkdown>((resolve, reject) => {
      pending.set(id, { job, resolve, reject });
      worker!.postMessage({ id, job });
      signal.addEventListener(
        "abort",
        () => {
          if (!pending.delete(id)) return;
          reject(signal.reason);
          // The worker runs one render at a time; only a new worker is rid of this one.
          worker?.terminate();
          worker = pending.size ? start() : undefined;
          if (worker) for (const [other, request] of pending) worker.postMessage({ id: other, job: request.job });
        },
        { once: true },
      );
    });
  };
}

/** Renders in the app's render Worker, bundled by Vite in development and production builds. */
export const renderInWorker = renderClient(() => new Worker(script, { type: "module" }));
