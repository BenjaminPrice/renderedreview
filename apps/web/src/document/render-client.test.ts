// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderedMarkdown } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import { renderClient, type WorkerLike } from "./render-client";
import type { RenderJob } from "./render-job";

/** A Worker stand-in that records posts; the test answers for it. */
class FakeWorker implements WorkerLike {
  posted: { id: number; job: RenderJob }[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  postMessage(message: { id: number; job: RenderJob }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const job = (path: string): RenderJob => ({ source: "# Hi\n", pr: { host: "h", owner: "o", repo: "r", number: 1 }, sha: "s", path });
const doc = (tag: string) => ({ tree: { type: "root", children: [] }, nodes: [], tag }) as unknown as RenderedMarkdown;

function setup() {
  const workers: FakeWorker[] = [];
  const render = renderClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { render, workers };
}

describe("renderClient", () => {
  it("starts one worker on first use and matches replies to requests by id", async () => {
    const { render, workers } = setup();
    expect(workers).toHaveLength(0);
    const a = render(job("a.md"), new AbortController().signal);
    const b = render(job("b.md"), new AbortController().signal);
    expect(workers).toHaveLength(1);
    const [pa, pb] = workers[0]!.posted;
    expect(pa!.job.path).toBe("a.md");
    expect(pa!.id).not.toBe(pb!.id);
    workers[0]!.reply({ id: pb!.id, rendered: doc("b") });
    workers[0]!.reply({ id: pa!.id, rendered: doc("a") });
    expect(await a).toMatchObject({ tag: "a" });
    expect(await b).toMatchObject({ tag: "b" });
  });

  it("rejects with the worker's render error", async () => {
    const { render, workers } = setup();
    const a = render(job("a.mdx"), new AbortController().signal);
    workers[0]!.reply({ id: workers[0]!.posted[0]!.id, error: "Invalid MDX at line 1, column 7: bad" });
    await expect(a).rejects.toThrow("Invalid MDX at line 1, column 7: bad");
  });

  it("aborting stops the stale render and hands the rest to a fresh worker", async () => {
    const { render, workers } = setup();
    const stale = new AbortController();
    const a = render(job("a.md"), stale.signal);
    const b = render(job("b.md"), new AbortController().signal);
    stale.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted.map((p) => p.job.path)).toEqual(["b.md"]);
    workers[1]!.reply({ id: workers[1]!.posted[0]!.id, rendered: doc("b") });
    expect(await b).toMatchObject({ tag: "b" });
  });

  it("an already aborted request never reaches the worker", async () => {
    const { render, workers } = setup();
    await expect(render(job("a.md"), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(0);
  });

  it("a worker that fails to load fails its requests, and the next request starts a new one", async () => {
    const { render, workers } = setup();
    const a = render(job("a.md"), new AbortController().signal);
    workers[0]!.onerror?.(new Event("error"));
    await expect(a).rejects.toThrow("The document renderer failed to start");
    void render(job("b.md"), new AbortController().signal);
    expect(workers).toHaveLength(2);
  });

  it("rejects, instead of throwing, where Workers cannot start", async () => {
    const render = renderClient(() => {
      throw new ReferenceError("Worker is not defined");
    });
    await expect(render(job("a.md"), new AbortController().signal)).rejects.toThrow("Worker is not defined");
  });
});
