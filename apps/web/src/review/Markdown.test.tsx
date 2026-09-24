// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The shape of a deploy-preview bot comment: a wide table in a narrow rail.
const TABLE = [
  "| Status | Deployment URL | Commit | Updated (UTC) | Details |",
  "| --- | --- | --- | --- | --- |",
  "| Success | https://preview.example.dev | d4abcf8 | 2026-09-24T07:11:31Z | [Visit](https://dash.example) |",
].join("\n");

describe("comment tables", () => {
  it("scroll horizontally in a keyboard-focusable, labelled region", () => {
    render(<Markdown source={TABLE} />);
    const region = screen.getByRole("region", { name: "Scrollable table" });
    expect(region.tabIndex).toBe(0);
    expect(within(region).getByRole("table")).toBeTruthy();
    expect(within(region).getByRole("columnheader", { name: "Deployment URL" })).toBeTruthy();
  });

  it("expand into a modal dialog showing the same table, and close back to the button", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    render(<Markdown source={TABLE} />);
    const expand = screen.getByRole("button", { name: "Expand table" });
    await userEvent.click(expand);

    expect(showModal).toHaveBeenCalledOnce();
    const dialog = screen.getByRole("dialog", { name: "Table" });
    expect(within(dialog).getByRole("columnheader", { name: "Updated (UTC)" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /Visit/ }).getAttribute("href")).toBe("https://dash.example");
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);

    await userEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
  });

  it("return focus to the button when the dialog closes another way (Escape)", async () => {
    render(<Markdown source={TABLE} />);
    const expand = screen.getByRole("button", { name: "Expand table" });
    await userEvent.click(expand);
    // The browser closes a modal dialog on Escape; happy-dom does not, so close it as the browser would.
    (screen.getByRole("dialog") as HTMLDialogElement).close();
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(expand);
  });

  it("each table in a comment has its own expand button", () => {
    render(<Markdown source={`${TABLE}\n\ntext\n\n${TABLE}`} />);
    expect(screen.getAllByRole("button", { name: "Expand table" })).toHaveLength(2);
  });
});
