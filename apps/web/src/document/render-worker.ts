// SPDX-License-Identifier: AGPL-3.0-only
// Module Worker that renders large documents off the main thread (see ./render-client.ts).
/// <reference lib="webworker" />
import type { RenderReply } from "./render-client";
import { type RenderJob, renderJob } from "./render-job";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = ({ data: { id, job } }: MessageEvent<{ id: number; job: RenderJob }>) => {
  let reply: RenderReply;
  try {
    reply = { id, rendered: renderJob(job) };
  } catch (error) {
    reply = { id, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};
