// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Diagram fences in a rendered document, with a fake renderer in place of Mermaid.
import { createDiagramRegistry, type DiagramRenderer } from "@rendered-review/diagram-domain";
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RenderedDocument } from "../document/document";
import { renderWithRouter } from "../test-utils";
import { DiagramRegistryContext } from "./registry";

const LINK = { host: "github.com", owner: "acme", repo: "widgets", sha: "0123456", path: "docs/flow.md" };

const DOC = [
  "# Flow", //                      1
  "", //                            2
  "```mermaid", //                  3
  "flowchart LR", //                4
  "  title Delivery flow", //       5
  "  A --> B", //                   6
  "```", //                         7
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
].join("\n");

let render: ReturnType<typeof vi.fn<DiagramRenderer["render"]>>;
let load: ReturnType<typeof vi.fn<() => Promise<DiagramRenderer>>>;
let blobOid = 0;

beforeEach(() => {
  render = vi.fn(async ({ theme }) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" data-theme="${theme}"/>`,
  }));
  load = vi.fn(async () => ({ id: "fake", fenceNames: ["mermaid"], version: "1", render }));
  blobOid++; // a fresh cache key per test
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

async function show(
  source = DOC,
  changes: { start: number; end: number; kind: "added" | "modified" }[] = [],
  url?: string,
) {
  const registry = createDiagramRegistry([{ label: "Mermaid", fenceNames: ["mermaid"], load }]);
  const rendered = renderMarkdown(source);
  return renderWithRouter(
    () => (
      <DiagramRegistryContext value={registry}>
        <RenderedDocument rendered={rendered} changes={changes} link={LINK} blobOid={`blob${blobOid}`} />
      </DiagramRegistryContext>
    ),
    url,
  );
}

const figure = () => screen.getByRole("figure", { name: "Mermaid diagram: Delivery flow" });

it("never loads a renderer for a document without diagram fences", async () => {
  await show("# Title\n\n```ts\nconst x = 1;\n```\n\n```unknown-diagram\nA\n```\n");
  expect(screen.queryByRole("figure")).toBeNull();
  expect(screen.getByText("const x = 1;")).toBeTruthy();
  await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(load).not.toHaveBeenCalled();
});

it("renders a diagram fence as an image named after the diagram, mapped to the whole fence", async () => {
  await show(DOC, [{ start: 6, end: 6, kind: "modified" }]);
  expect(within(figure()).getByText("Rendering diagram…")).toBeTruthy();
  const img = await within(figure()).findByRole("img", { name: "Mermaid diagram: Delivery flow" });
  expect(img.getAttribute("src")).toMatch(/^blob:/);
  expect(load).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledWith(
    expect.objectContaining({ source: "flowchart LR\n  title Delivery flow\n  A --> B", theme: "light" }),
  );
  // The block is the fence's source node: comments and change markers attach to it.
  const rendered = renderMarkdown(DOC);
  const fence = rendered.nodes.find((n) => n.type === "code" && n.lang === "mermaid")!;
  expect(figure().getAttribute("data-rr-id")).toBe(String(fence.id));
  expect(figure().getAttribute("data-rr-change")).toBe("modified");
  // Non-diagram fences stay code blocks.
  expect(screen.getByText("const x = 1;").closest("pre")).toBeTruthy();
});

it("names a diagram without a title after its first line", async () => {
  await show("```mermaid\n\nsequenceDiagram\n  A->>B: hi\n```\n");
  expect(await screen.findByRole("img", { name: "Mermaid diagram: sequenceDiagram" })).toBeTruthy();
});

it("falls back to the source with a concise error when rendering fails", async () => {
  render.mockRejectedValue(new Error("Parse error on line 2"));
  await show();
  expect(await within(figure()).findByText("Could not render this diagram: Parse error on line 2")).toBeTruthy();
  const source = within(figure()).getByLabelText("Mermaid source");
  expect(source.textContent).toContain("A --> B");
  const line = within(source).getByRole("link", { name: "Line 6 on GitHub (opens in new tab)" });
  expect(line.getAttribute("href")).toBe("https://github.com/acme/widgets/blob/0123456/docs/flow.md#L6");
  // The rest of the document is unaffected.
  expect(screen.getByRole("heading", { name: "Flow" })).toBeTruthy();
});

it("falls back to the source when the renderer cannot be loaded", async () => {
  load.mockRejectedValue(new Error("Failed to fetch dynamically imported module"));
  await show();
  expect(await within(figure()).findByText(/^Could not render this diagram: Failed to fetch/)).toBeTruthy();
  expect(within(figure()).getByLabelText("Mermaid source")).toBeTruthy();
});

it("re-renders in the dark theme when the theme changes", async () => {
  await show();
  const img = await within(figure()).findByRole("img");
  const lightSrc = img.getAttribute("src");
  await act(async () => {
    document.documentElement.dataset.theme = "dark";
  });
  await vi.waitFor(() => expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" })));
  await vi.waitFor(() => expect(within(figure()).getByRole("img").getAttribute("src")).not.toBe(lightSrc));
});

it("reuses cached output for the same fence, renderer version and theme", async () => {
  const first = await show();
  await within(figure()).findByRole("img");
  first.unmount();
  await show();
  await within(figure()).findByRole("img");
  expect(render).toHaveBeenCalledTimes(1);
});

it("zooms, fits and toggles the source from the keyboard", async () => {
  const user = userEvent.setup();
  await show();
  const img = await within(figure()).findByRole("img");
  const level = within(figure()).getByText("Fit");
  await user.click(within(figure()).getByRole("button", { name: "Zoom in" }));
  expect(level.textContent).toBe("125%");
  expect(img.style.width).toBe("250px");
  await user.click(within(figure()).getByRole("button", { name: "Zoom out" }));
  await user.click(within(figure()).getByRole("button", { name: "Zoom out" }));
  expect(level.textContent).toBe("75%");
  await user.click(within(figure()).getByRole("button", { name: "Fit to width" }));
  expect(level.textContent).toBe("Fit");
  expect(img.style.width).toBe("");

  const toggle = within(figure()).getByRole("button", { name: "Source" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  toggle.focus();
  await user.keyboard("{Enter}");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  const source = within(figure()).getByLabelText("Mermaid source");
  expect(
    within(source)
      .getAllByRole("link")
      .map((a) => a.textContent),
  ).toEqual(["4", "5", "6"]);
  expect(within(figure()).queryByRole("img")).toBeNull();
  await user.keyboard("{Enter}");
  expect(within(figure()).getByRole("img")).toBeTruthy();
});

it("copies the diagram source", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await show();
  await user.click(within(figure()).getByRole("button", { name: "Copy source" }));
  expect(writeText).toHaveBeenCalledWith("flowchart LR\n  title Delivery flow\n  A --> B");
  expect(within(figure()).getByRole("button", { name: "Copied" })).toBeTruthy();
});

it("opens a larger view in a modal and returns focus when it closes", async () => {
  const user = userEvent.setup();
  await show();
  await within(figure()).findByRole("img");
  const open = within(figure()).getByRole("button", { name: "Open larger view" });
  await user.click(open);
  const dialog = screen.getByRole("dialog", { name: "Mermaid diagram: Delivery flow" });
  expect(within(dialog).getByRole("img").getAttribute("src")).toMatch(/^blob:/);
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(open);
});

it("shows the source with the targeted line when a line link points inside the fence", async () => {
  await show(DOC, [], "/#L5");
  const source = within(figure()).getByLabelText("Mermaid source");
  const line = within(source)
    .getByRole("link", { name: /^Line 5 / })
    .closest(".rr-raw-line")!;
  expect(line.hasAttribute("data-rr-target")).toBe(true);
  expect(within(figure()).getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true");
});

it("lets keyboard readers scroll the document's code blocks and tables", async () => {
  await show("```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  expect(screen.getByText("const x = 1;").closest("pre")!.tabIndex).toBe(0);
  expect(screen.getByRole("table").tabIndex).toBe(0);
});
