// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// The adapter's side of the frame protocol. jsdom never loads the frame, so each test plays it:
// it reads what the adapter posts and answers as the frame would. Real rendering is checked in a
// browser against a production build.
import { afterEach, expect, it, vi } from "vitest";
import { closeMermaidFrame, loadMermaid } from "./mermaid";

const frames = () => [...document.querySelectorAll<HTMLIFrameElement>("iframe")];

/** The current frame, with its posted messages captured and a way to answer as the frame. */
function frame() {
  const el = frames().at(-1)!;
  const win = el.contentWindow!;
  const posted = vi.spyOn(win, "postMessage");
  const reply = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: win }));
  return { el, posted, reply };
}

afterEach(() => closeMermaidFrame());

const input = (
  source = "graph TD; A-->B",
  theme: "light" | "dark" = "light",
  signal = new AbortController().signal,
) => ({
  source,
  theme,
  signal,
});

it("opens one sandboxed, hidden frame and resolves once it is ready", async () => {
  const loading = loadMermaid();
  expect(frames()).toHaveLength(1);
  const { el, reply } = frame();
  expect(el.getAttribute("sandbox")).toBe("allow-scripts");
  expect(el.getAttribute("src")).toMatch(/^\/frames\/mermaid\?script=%2F.+\.js$/);
  expect(el.getAttribute("aria-hidden")).toBe("true");
  expect(el.tabIndex).toBe(-1);
  reply({ ready: true });
  const renderer = await loading;
  expect(renderer).toMatchObject({ id: "mermaid", fenceNames: ["mermaid"] });
  expect(renderer.version).toMatch(/^\d+\.\d+\.\d+/);
  await loadMermaid();
  expect(frames()).toHaveLength(1);
});

it("posts the source and theme and returns sanitized SVG", async () => {
  const loading = loadMermaid();
  const { posted, reply } = frame();
  reply({ ready: true });
  const renderer = await loading;
  const result = renderer.render(input("graph TD; A-->B", "dark"));
  await vi.waitFor(() => expect(posted).toHaveBeenCalled());
  const [message, target] = posted.mock.calls[0]!;
  expect(message).toMatchObject({ source: "graph TD; A-->B", theme: "dark" });
  expect(target).toBe("*");
  reply({ id: (message as { id: number }).id, svg: '<svg viewBox="0 0 10 10" onload="alert(1)"><g/></svg>' });
  const { svg } = await result;
  expect(svg).toContain('width="10"');
  expect(svg).not.toContain("onload");
});

it("ignores messages from other windows", async () => {
  const loading = loadMermaid();
  const { reply } = frame();
  window.dispatchEvent(new MessageEvent("message", { data: { ready: true }, source: window }));
  let settled = false;
  void loading.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 10));
  expect(settled).toBe(false);
  reply({ ready: true });
  await loading;
});

it("rejects with the frame's error", async () => {
  const loading = loadMermaid();
  const { posted, reply } = frame();
  reply({ ready: true });
  const result = (await loading).render(input("graph TD; A--"));
  await vi.waitFor(() => expect(posted).toHaveBeenCalled());
  reply({ id: (posted.mock.calls[0]![0] as { id: number }).id, error: "Parse error on line 1" });
  await expect(result).rejects.toThrow("Parse error on line 1");
});

it("fails to load when the renderer script is unavailable, and retries with a new frame", async () => {
  const loading = loadMermaid();
  frame().reply({ ready: false });
  await expect(loading).rejects.toThrow("Could not load the Mermaid renderer");
  expect(frames()).toHaveLength(0);
  const again = loadMermaid();
  expect(frames()).toHaveLength(1);
  frame().reply({ ready: true });
  await again;
});

it("replaces a frame whose render timed out", async () => {
  const loading = loadMermaid();
  const first = frame();
  first.reply({ ready: true });
  const renderer = await loading;
  const controller = new AbortController();
  void renderer.render(input(undefined, undefined, controller.signal)).catch(() => {});
  await vi.waitFor(() => expect(first.posted).toHaveBeenCalled());
  controller.abort(new DOMException("timed out", "TimeoutError"));
  expect(frames()).toHaveLength(0);
  const next = renderer.render(input("graph LR; X-->Y"));
  expect(frames()).toHaveLength(1);
  const second = frame();
  second.reply({ ready: true });
  await vi.waitFor(() => expect(second.posted).toHaveBeenCalled());
  second.reply({ id: (second.posted.mock.calls[0]![0] as { id: number }).id, svg: "<svg><g/></svg>" });
  await expect(next).resolves.toMatchObject({ svg: expect.stringContaining("<svg") });
});

it("keeps the frame when a render is merely cancelled", async () => {
  const loading = loadMermaid();
  const { el, reply, posted } = frame();
  reply({ ready: true });
  const controller = new AbortController();
  void (await loading).render(input(undefined, undefined, controller.signal)).catch(() => {});
  await vi.waitFor(() => expect(posted).toHaveBeenCalled());
  controller.abort();
  expect(frames()).toEqual([el]);
});
