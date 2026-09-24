// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "../test-utils";
import { AppShell, useShell } from "./AppShell";

// The top bar asks the server who is signed in; this deployment has no sign-in.
beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.rail;
  delete document.documentElement.dataset.theme;
});

// Stands in for a margin marker: anything that opens the rail from the document.
function OpenRail() {
  const { openRail } = useShell();
  return (
    <button type="button" onClick={openRail}>
      Marker
    </button>
  );
}

const renderShell = () =>
  renderWithRouter(() => (
    <AppShell title="PR title" sidebar={<p>Docs</p>} commentCount={2} rail={<p>Threads</p>}>
      <OpenRail />
    </AppShell>
  ));

const commentsButton = () => screen.getByRole("button", { name: /^Comments/ });
const rail = () => screen.getByRole("complementary", { name: /Comments/ });
const railMode = () => document.documentElement.dataset.rail;

describe("layout", () => {
  it("exposes banner, navigation, main and complementary landmarks", async () => {
    await renderShell();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Documents" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(rail()).toBeTruthy();
    expect(screen.getByRole("link", { name: "Rendered Review home" }).getAttribute("href")).toBe("/");
  });
});

describe("comment rail", () => {
  it("starts pinned open, with the Comments button as its pressed toggle", async () => {
    await renderShell();
    expect(commentsButton().getAttribute("aria-pressed")).toBe("true");
    expect(commentsButton().getAttribute("aria-controls")).toBe("rr-rail");
    expect(rail().id).toBe("rr-rail");
    expect(railMode()).toBe("pinned");
  });

  it("has no pin or collapse controls in the rail itself", async () => {
    await renderShell();
    expect(within(rail()).queryAllByRole("button")).toEqual([]);
  });

  it("collapses and re-pins from the Comments button, remembering the choice", async () => {
    await renderShell();
    await userEvent.click(commentsButton());
    expect(commentsButton().getAttribute("aria-pressed")).toBe("false");
    expect(railMode()).toBe("collapsed");

    cleanup();
    await renderShell();
    expect(commentsButton().getAttribute("aria-pressed")).toBe("false");
    expect(railMode()).toBe("collapsed");

    await userEvent.click(commentsButton());
    expect(railMode()).toBe("pinned");
    cleanup();
    await renderShell();
    expect(commentsButton().getAttribute("aria-pressed")).toBe("true");
  });

  describe("slide-over", () => {
    async function openSlideOver() {
      localStorage.setItem("rr-rail", "collapsed");
      await renderShell();
      await userEvent.click(screen.getByRole("button", { name: "Marker" }));
      expect(railMode()).toBe("slide");
    }

    it("opens from the document with focus in the rail and only a Close button", async () => {
      await openSlideOver();
      expect(rail().contains(document.activeElement)).toBe(true);
      expect(
        within(rail())
          .getAllByRole("button")
          .map((b) => b.getAttribute("aria-label")),
      ).toEqual(["Close comments"]);
      // Transient: the saved collapsed choice is kept.
      expect(commentsButton().getAttribute("aria-pressed")).toBe("false");
      expect(localStorage.getItem("rr-rail")).toBe("collapsed");
    });

    it("Close collapses it and returns focus to the Comments button", async () => {
      await openSlideOver();
      await userEvent.click(within(rail()).getByRole("button", { name: "Close comments" }));
      expect(railMode()).toBe("collapsed");
      expect(document.activeElement).toBe(commentsButton());
    });

    it("Escape collapses it and returns focus to the Comments button", async () => {
      await openSlideOver();
      await userEvent.keyboard("{Escape}");
      expect(railMode()).toBe("collapsed");
      expect(within(rail()).queryByRole("button", { name: "Close comments" })).toBeNull();
      expect(document.activeElement).toBe(commentsButton());
    });

    it("pressing Comments pins the rail", async () => {
      await openSlideOver();
      await userEvent.click(commentsButton());
      expect(railMode()).toBe("pinned");
      expect(commentsButton().getAttribute("aria-pressed")).toBe("true");
      expect(localStorage.getItem("rr-rail")).toBe("pinned");
    });
  });

  it("ignores Escape while pinned", async () => {
    await renderShell();
    await userEvent.keyboard("{Escape}");
    expect(railMode()).toBe("pinned");
  });
});

describe("theme toggle", () => {
  it("cycles System, Light, Dark and remembers the choice", async () => {
    await renderShell();
    const toggle = () => screen.getByRole("button", { name: /^Theme:/ });
    expect(toggle().getAttribute("aria-label")).toBe("Theme: System. Switch to Light");

    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-label")).toBe("Theme: Light. Switch to Dark");
    expect(document.documentElement.dataset.theme).toBe("light");

    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-label")).toBe("Theme: Dark. Switch to System");
    expect(document.documentElement.dataset.theme).toBe("dark");

    cleanup();
    await renderShell();
    expect(toggle().getAttribute("aria-label")).toBe("Theme: Dark. Switch to System");

    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-label")).toBe("Theme: System. Switch to Light");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("rr-theme")).toBeNull();
  });
});
