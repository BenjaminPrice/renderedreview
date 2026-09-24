// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// The frame's side of the protocol. In jsdom the test window is its own parent, so the test posts
// as the page would and reads what the renderer posts back.
import { afterEach, expect, it, vi } from "vitest";
import { serveRenderer } from "./frame-entry";

const posted = () => vi.mocked(window.postMessage).mock.calls.map(([data]) => data);
const send = (data: unknown, source: MessageEventSource | null = window) =>
  window.dispatchEvent(new MessageEvent("message", { data, source }));

afterEach(() => vi.restoreAllMocks());

it("announces readiness once loaded, then answers each render in order", async () => {
  vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const stop = serveRenderer(async () => async ({ source, theme }) => {
    if (source === "bad") throw new Error("Syntax error");
    return `<svg data-theme="${theme}">${source}</svg>`;
  });
  expect((globalThis as { rrRenderer?: boolean }).rrRenderer).toBe(true);
  await vi.waitFor(() => expect(posted()).toEqual([{ ready: true }]));
  send({ id: 1, source: "a", theme: "dark" });
  send({ id: 2, source: "bad", theme: "light" });
  send({ id: 3, source: "ignored", theme: "light" }, null);
  await vi.waitFor(() => expect(posted()).toHaveLength(3));
  expect(posted().slice(1)).toEqual([
    { id: 1, svg: '<svg data-theme="dark">a</svg>' },
    { id: 2, error: "Syntax error" },
  ]);
  stop();
});

it("announces a failed load", async () => {
  vi.spyOn(window, "postMessage").mockImplementation(() => {});
  serveRenderer(() => Promise.reject(new Error("no wasm")));
  await vi.waitFor(() => expect(posted()).toEqual([{ ready: false }]));
});
