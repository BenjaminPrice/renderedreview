// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// How the page starts a bundled renderer: built, in the sandboxed frame's Worker (the page hands
// the frame the script's text); in development, in a Worker of its own. jsdom never loads the
// frame, so the test answers as it would.
import { afterEach, expect, it, vi } from "vitest";
import { bundledHost, frameRenderer } from "./frame-client";

const input = { source: "a -> b", theme: "dark" as const, signal: new AbortController().signal };
let close = () => {};

afterEach(() => {
  close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(dev: boolean) {
  const renderer = frameRenderer({
    id: "graphviz",
    fenceNames: ["dot"],
    version: "1",
    label: "Graphviz",
    host: bundledHost("/assets/graphviz-frame-x.js", dev),
  });
  close = renderer.close;
  return renderer;
}

function frame() {
  const el = document.querySelector("iframe")!;
  const win = el.contentWindow!;
  const posted = vi.spyOn(win, "postMessage");
  const reply = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: win }));
  return { el, posted, reply };
}

it("hands the sandboxed frame the renderer script, then renders through it", async () => {
  const fetch = vi.fn(async () => new Response("/* renderer */"));
  vi.stubGlobal("fetch", fetch);
  const loading = open(false).load();
  const { el, posted, reply } = frame();
  expect(el.getAttribute("src")).toBe("/frames/renderer");
  expect(el.getAttribute("sandbox")).toBe("allow-scripts");
  reply({ host: true });
  await vi.waitFor(() => expect(posted).toHaveBeenCalledWith({ script: "/* renderer */" }, "*"));
  expect(fetch).toHaveBeenCalledWith("/assets/graphviz-frame-x.js");
  reply({ ready: true });
  const renderer = await loading;
  const result = renderer.render(input);
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  const message = posted.mock.calls[1]![0] as { id: number };
  expect(message).toMatchObject({ source: "a -> b", theme: "dark" });
  reply({ id: message.id, svg: '<svg viewBox="0 0 4 2" onload="x()"/>' });
  const { svg } = await result;
  expect(svg).toContain('width="4"');
  expect(svg).not.toContain("onload");
});

it("fails to load when the renderer script cannot be fetched", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
  const loading = open(false).load();
  frame().reply({ host: true });
  await expect(loading).rejects.toThrow("Could not load the Graphviz renderer");
  expect(document.querySelector("iframe")).toBeNull();
});

it("runs the development server's module in a Worker of the page's own", async () => {
  const workers: {
    url: unknown;
    options: unknown;
    worker: EventTarget & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
  }[] = [];
  vi.stubGlobal(
    "Worker",
    class extends EventTarget {
      postMessage = vi.fn();
      terminate = vi.fn();
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: unknown, options: unknown) {
        super();
        workers.push({ url, options, worker: this });
      }
    },
  );
  const loading = open(true).load();
  expect(workers).toHaveLength(1);
  expect(workers[0]).toMatchObject({ url: "/assets/graphviz-frame-x.js", options: { type: "module" } });
  const worker = workers[0]!.worker as unknown as { onmessage: (event: MessageEvent) => void; terminate: () => void };
  worker.onmessage(new MessageEvent("message", { data: { ready: true } }));
  await loading;
  close();
  expect(worker.terminate).toHaveBeenCalled();
});
