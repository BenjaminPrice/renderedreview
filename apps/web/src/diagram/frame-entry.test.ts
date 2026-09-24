// SPDX-License-Identifier: AGPL-3.0-only
// The renderer Worker's side of the protocol, with a stand-in for the Worker's global scope.
import { expect, it, vi } from "vitest";
import { serveRenderer } from "./frame-entry";

function scope() {
  const target = new EventTarget();
  const posted: unknown[] = [];
  return {
    posted,
    send: (data: unknown) => target.dispatchEvent(new MessageEvent("message", { data })),
    scope: {
      postMessage: (message: unknown) => void posted.push(message),
      addEventListener: (type: "message", listener: (event: MessageEvent) => void) =>
        target.addEventListener(type, listener as EventListener),
    },
  };
}

it("announces readiness once loaded, then answers each render in order", async () => {
  const { posted, send, scope: worker } = scope();
  serveRenderer(
    async () =>
      async ({ source, theme }) => {
        if (source === "bad") throw new Error("Syntax error");
        return `<svg data-theme="${theme}">${source}</svg>`;
      },
    worker,
  );
  await vi.waitFor(() => expect(posted).toEqual([{ ready: true }]));
  send({ id: 1, source: "a", theme: "dark" });
  send({ id: 2, source: "bad", theme: "light" });
  send({ id: 3, source: 42, theme: "light" });
  await vi.waitFor(() => expect(posted).toHaveLength(3));
  expect(posted.slice(1)).toEqual([
    { id: 1, svg: '<svg data-theme="dark">a</svg>' },
    { id: 2, error: "Syntax error" },
  ]);
});

it("announces a failed load", async () => {
  const { posted, scope: worker } = scope();
  serveRenderer(() => Promise.reject(new Error("no wasm")), worker);
  await vi.waitFor(() => expect(posted).toEqual([{ ready: false }]));
});

it("does nothing outside a Worker, so renderer modules can be imported by tests", () => {
  const load = vi.fn();
  serveRenderer(load);
  expect(load).not.toHaveBeenCalled();
});
