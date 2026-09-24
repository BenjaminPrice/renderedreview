// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { createDiagramRegistry, diagramCacheKey, renderDiagram, type DiagramRenderer } from "./index";

const fake = (render: DiagramRenderer["render"] = async ({ source }) => ({ svg: `<svg>${source}</svg>` })) =>
  ({ id: "fake", fenceNames: ["fake"], version: "1", render }) satisfies DiagramRenderer;

const input = (source = "graph TD", signal = new AbortController().signal) =>
  ({ source, theme: "light", signal }) as const;

describe("registry", () => {
  it("matches fence names case-insensitively and ignores unknown fences", () => {
    const registry = createDiagramRegistry([{ label: "X", fenceNames: ["mermaid"], load: async () => fake() }]);
    expect(registry.match("mermaid")).toBeDefined();
    expect(registry.match("Mermaid")).toBeDefined();
    expect(registry.match("ts")).toBeUndefined();
    expect(registry.match(undefined)).toBeUndefined();
  });

  it("imports a renderer only when asked, and only once", async () => {
    const load = vi.fn(async () => fake());
    const registry = createDiagramRegistry([{ label: "X", fenceNames: ["dot", "graphviz"], load }]);
    expect(load).not.toHaveBeenCalled();
    const entry = registry.match("dot")!;
    const [a, b] = await Promise.all([entry.load(), registry.match("graphviz")!.load()]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries a failed import on the next request", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(fake());
    const entry = createDiagramRegistry([{ label: "X", fenceNames: ["x"], load }]).match("x")!;
    await expect(entry.load()).rejects.toThrow("offline");
    await expect(entry.load()).resolves.toMatchObject({ id: "fake" });
  });
});

describe("renderDiagram limits", () => {
  it("returns the renderer's SVG", async () => {
    await expect(renderDiagram(fake(), input("a"))).resolves.toEqual({ svg: "<svg>a</svg>" });
  });

  it("refuses oversized input without calling the renderer", async () => {
    const render = vi.fn();
    await expect(renderDiagram(fake(render), input("x".repeat(11)), { maxInputChars: 10 })).rejects.toThrow(
      "Diagram source is too large (11 characters; the limit is 10)",
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("times out a renderer that never settles, and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const hang = fake(({ signal }) => {
      seen = signal;
      return new Promise(() => {});
    });
    await expect(renderDiagram(hang, input(), { timeoutMs: 20 })).rejects.toThrow("Diagram took too long to render");
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = renderDiagram(
      fake(() => new Promise(() => {})),
      input("a", controller.signal),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses oversized output", async () => {
    const big = fake(async () => ({ svg: "x".repeat(101) }));
    await expect(renderDiagram(big, input(), { maxOutputChars: 100 })).rejects.toThrow("Rendered diagram is too large");
  });

  it("passes renderer errors through", async () => {
    const broken = fake(async () => {
      throw new Error("Parse error on line 2");
    });
    await expect(renderDiagram(broken, input())).rejects.toThrow("Parse error on line 2");
  });
});

describe("diagramCacheKey", () => {
  const base = {
    blobOid: "abc123",
    range: { start: 10, end: 90 },
    renderer: fake(),
    theme: "light" as const,
  };

  it("is stable for the same inputs", () => {
    expect(diagramCacheKey(base)).toBe(diagramCacheKey({ ...base }));
  });

  it("changes with renderer version, theme, blob and fence range", () => {
    const key = diagramCacheKey(base);
    expect(diagramCacheKey({ ...base, renderer: { ...base.renderer, version: "2" } })).not.toBe(key);
    expect(diagramCacheKey({ ...base, theme: "dark" })).not.toBe(key);
    expect(diagramCacheKey({ ...base, blobOid: "def456" })).not.toBe(key);
    expect(diagramCacheKey({ ...base, range: { start: 10, end: 91 } })).not.toBe(key);
  });
});
