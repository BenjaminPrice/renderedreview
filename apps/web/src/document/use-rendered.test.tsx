// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import type { RenderedMarkdown } from "@rendered-review/markdown-domain";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { PrIdentity } from "../github/queries";
import type { DocEntry } from "./docs";
import { useRendered, WORKER_THRESHOLD_CHARS } from "./document";
import { renderInWorker } from "./render-client";
import type { RenderJob } from "./render-job";

vi.mock("./render-client", () => ({ renderInWorker: vi.fn() }));
const worker = vi.mocked(renderInWorker);

/** Worker calls the test settles by hand. */
let calls: { job: RenderJob; signal: AbortSignal; resolve(r: RenderedMarkdown): void; reject(e: unknown): void }[];
beforeEach(() => {
  calls = [];
  worker.mockReset();
  worker.mockImplementation(
    (job, signal) => new Promise((resolve, reject) => calls.push({ job, signal, resolve, reject })),
  );
});

const id = { host: "github.com", owner: "o", repo: "r", number: 7, headSha: "h", baseSha: "b" } as PrIdentity;
let seq = 0;
/** A distinct blob each time, so the render cache never answers across tests. */
const entry = (path = "doc.md"): DocEntry => ({ path, status: "modified", oid: `oid${++seq}` });
const large = (text: string) => `# ${text}\n\n${"word ".repeat(WORKER_THRESHOLD_CHARS / 5)}\n`;
const fake = (text: string) =>
  ({ tree: { type: "root", children: [] }, nodes: [], text }) as unknown as RenderedMarkdown;

it("renders documents up to the threshold on the main thread, at once", () => {
  const { result } = renderHook(() => useRendered(id, "h", entry(), "# Small\n"));
  expect(result.current.rendering).toBe(false);
  expect(result.current.result).toMatchObject({ nodes: [{ type: "heading", text: "Small" }] });
  expect(worker).not.toHaveBeenCalled();
});

it("renders larger documents in the Worker, showing progress until done, then caches them per blob", async () => {
  const doc = entry();
  const source = large("Big");
  const { result } = renderHook(() => useRendered(id, "h", doc, source));
  expect(result.current).toEqual({ result: undefined, rendering: true });
  expect(calls[0]!.job).toEqual({
    source,
    pr: { host: "github.com", owner: "o", repo: "r", number: 7 },
    sha: "h",
    path: "doc.md",
  });
  await act(async () => calls[0]!.resolve(fake("big")));
  expect(result.current).toEqual({ result: fake("big"), rendering: false });

  // Revisiting the blob reuses the result: no second render, no progress state.
  const again = renderHook(() => useRendered(id, "h", doc, source));
  expect(again.result.current).toEqual({ result: fake("big"), rendering: false });
  expect(worker).toHaveBeenCalledTimes(1);
});

it("switching documents mid-render cancels the stale render; only the latest result is applied", async () => {
  const first = entry("first.md");
  const second = entry("second.md");
  const { result, rerender } = renderHook(({ doc, source }) => useRendered(id, "h", doc, source), {
    initialProps: { doc: first, source: large("First") },
  });
  rerender({ doc: second, source: large("Second") });
  expect(calls[0]!.signal.aborted).toBe(true);
  expect(calls[1]!.job.path).toBe("second.md");
  expect(result.current.rendering).toBe(true);

  // A stale reply that raced the abort is ignored.
  await act(async () => calls[0]!.resolve(fake("first")));
  expect(result.current).toEqual({ result: undefined, rendering: true });
  await act(async () => calls[1]!.resolve(fake("second")));
  expect(result.current).toEqual({ result: fake("second"), rendering: false });
});

it("falls back to the main thread when the Worker cannot render", async () => {
  const doc = entry();
  const { result } = renderHook(() => useRendered(id, "h", doc, large("Fallback")));
  await act(async () => calls[0]!.reject(new Error("The document renderer failed to start")));
  expect(result.current.rendering).toBe(false);
  expect(result.current.result).toMatchObject({
    nodes: expect.arrayContaining([expect.objectContaining({ type: "heading", text: "Fallback" })]),
  });
});

it("reports invalid MDX as the render error", () => {
  const { result } = renderHook(() => useRendered(id, "h", entry("a.mdx"), "<Tabs>\n"));
  expect(result.current.result).toBeInstanceOf(Error);
});
