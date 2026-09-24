// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The comment rail inside the app shell: filters, connector preference and visibility, margin markers.
import type { SourceNode } from "@rendered-review/markdown-domain";
import type { ThreadPlacement } from "@rendered-review/review-domain";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "../test-utils";
import { AppShell } from "../ui/AppShell";
import { CommentRail, RailHeader } from "./CommentRail";
import { comment, lineAnchor, OLD, repository, thread } from "./fixtures";
import { DEFAULT_FILTERS, filterCounts } from "./model";
import { threadDomId } from "./ThreadCard";

const block = (id: number) => ({ id }) as SourceNode;
const placements: ThreadPlacement[] = [
  { thread: thread("current", lineAnchor(1), "unresolved", [comment({ body: "Current one" })]), blocks: [block(1)] },
  {
    thread: thread("resolved", lineAnchor(3), "resolved", [comment({ body: "Resolved one" }), comment()]),
    blocks: [block(2)],
  },
  { thread: thread("file", { type: "file" }, "unknown", [comment({ body: "File one" })]), blocks: [] },
  {
    thread: thread("old", lineAnchor(9, 9, "outdated", OLD), "unresolved", [comment({ body: "Old one" })]),
    blocks: [],
  },
];

function Page({ items = placements }: { items?: ThreadPlacement[] }) {
  const docRef = useRef<HTMLElement>(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const threads = items.map((p) => p.thread);
  return (
    <AppShell
      commentCount={threads.length}
      railHeader={<RailHeader counts={filterCounts(threads)} filters={filters} onFiltersChange={setFilters} />}
      rail={<CommentRail placements={items} repository={repository} filters={filters} docContainerRef={docRef} />}
    >
      <article ref={docRef} aria-label="Rendered document" style={{ paddingRight: 48 }}>
        <p data-rr-id="1">First paragraph</p>
        <p data-rr-id="2">Second paragraph</p>
      </article>
    </AppShell>
  );
}

const renderPage = (items?: ThreadPlacement[]) => renderWithRouter(() => <Page items={items} />);
const rail = () => screen.getByRole("complementary", { name: /Comments/ });
const commentsButton = () => screen.getByRole("button", { name: /^Comments/ });
const chip = (name: RegExp) =>
  within(screen.getByRole("group", { name: "Filter comments" })).getByRole("button", { name });
const connectorSwitch = () => screen.queryByRole("switch", { name: "Show connectors" });
const wires = () => document.querySelector(".rr-wires");
const article = () => screen.getByRole("article", { name: "Rendered document" });

let reducedMotion = true;
beforeEach(() => {
  reducedMotion = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.rail;
});

describe("threads and filters", () => {
  it("counts threads per state; Historical is off by default", async () => {
    await renderPage();
    const chips = within(screen.getByRole("group", { name: "Filter comments" })).getAllByRole("button");
    expect(chips.map((c) => [c.textContent, c.getAttribute("aria-pressed")])).toEqual([
      ["Current 2", "true"],
      ["Resolved 1", "true"],
      ["Outdated 1", "true"],
      ["Historical 0", "false"],
    ]);
  });

  it("keeps resolved threads collapsed in place", async () => {
    await renderPage();
    const resolved = within(rail()).getByText("Resolved one").closest("details")!;
    expect(resolved.open).toBe(false);
    expect(within(rail()).getByText("Current one")).toBeTruthy();
  });

  it("lists file-level and outdated threads apart from the aligned ones", async () => {
    await renderPage();
    const group = within(rail()).getByRole("region", { name: "File-level and outdated" });
    expect(within(group).getByText("File one")).toBeTruthy();
    expect(within(group).getByText("Old one")).toBeTruthy();
  });

  it("filters threads by state without losing the rest", async () => {
    await renderPage();
    await userEvent.click(chip(/^Resolved/));
    expect(chip(/^Resolved/).getAttribute("aria-pressed")).toBe("false");
    expect(within(rail()).queryByText("Resolved one")).toBeNull();
    expect(within(rail()).getByText("Current one")).toBeTruthy();

    await userEvent.click(chip(/^Current/));
    await userEvent.click(chip(/^Outdated/));
    expect(within(rail()).getByText("No comments match the selected filters.")).toBeTruthy();

    await userEvent.click(chip(/^Resolved/));
    expect(within(rail()).getByText("Resolved one")).toBeTruthy();
  });

  it("says when a document has no comments", async () => {
    await renderPage([]);
    expect(within(rail()).getByText("No review comments on this document.")).toBeTruthy();
  });
});

describe("connector preference", () => {
  it("is a switch in the user preferences group, off by default and remembered", async () => {
    await renderPage();
    const group = screen.getByRole("group", { name: "User preferences" });
    expect(within(group).getByRole("switch", { name: "Show connectors" }).getAttribute("aria-checked")).toBe("false");

    await userEvent.click(connectorSwitch()!);
    expect(connectorSwitch()!.getAttribute("aria-checked")).toBe("true");

    cleanup();
    await renderPage();
    expect(connectorSwitch()!.getAttribute("aria-checked")).toBe("true");
  });

  it("is hidden in the slide-over", async () => {
    localStorage.setItem("rr-rail", "collapsed");
    await renderPage();
    expect(connectorSwitch()).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^1 comment, current/ }));
    expect(document.documentElement.dataset.rail).toBe("slide");
    expect(connectorSwitch()).toBeNull();
  });
});

describe("connector visibility", () => {
  it("does not draw connectors while the preference is off", async () => {
    await renderPage();
    expect(wires()).toBeNull();
  });

  it("draws one connector per aligned thread, only while the rail is pinned", async () => {
    localStorage.setItem("rr-connectors", "on");
    await renderPage();
    await vi.waitFor(() => expect(wires()?.querySelectorAll("path")).toHaveLength(2));
    expect(article().contains(wires())).toBe(true);

    await userEvent.click(commentsButton());
    await vi.waitFor(() => expect(wires()).toBeNull());
    expect(connectorSwitch()!.getAttribute("aria-checked")).toBe("true");

    // Slide-over: still none.
    await userEvent.click(screen.getByRole("button", { name: /^1 comment, current/ }));
    expect(document.documentElement.dataset.rail).toBe("slide");
    expect(wires()).toBeNull();

    // Pinned again: they come back.
    await userEvent.click(commentsButton());
    await vi.waitFor(() => expect(wires()?.querySelectorAll("path")).toHaveLength(2));
  });

  it("removes connectors when switched off", async () => {
    localStorage.setItem("rr-connectors", "on");
    await renderPage();
    await vi.waitFor(() => expect(wires()).toBeTruthy());
    await userEvent.click(connectorSwitch()!);
    await vi.waitFor(() => expect(wires()).toBeNull());
  });

  it("keeps connectors when switched back on before the retraction finishes", async () => {
    reducedMotion = false;
    Object.defineProperty(SVGElement.prototype, "getTotalLength", { value: () => 100, configurable: true });
    await renderPage();
    await userEvent.click(connectorSwitch()!);
    await vi.waitFor(() => expect(wires()?.querySelector("path")).toBeTruthy());

    vi.useFakeTimers();
    await act(async () => fireEvent.click(connectorSwitch()!));
    await act(async () => fireEvent.click(connectorSwitch()!));
    await act(async () => vi.runAllTimersAsync());
    expect(connectorSwitch()!.getAttribute("aria-checked")).toBe("true");
    expect(wires()).toBeTruthy();
    delete (SVGElement.prototype as { getTotalLength?: unknown }).getTotalLength;
  });

  it("with reduced motion, connectors appear without animating and the rail collapses at once", async () => {
    localStorage.setItem("rr-connectors", "on");
    await renderPage();
    await vi.waitFor(() => expect(wires()).toBeTruthy());
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const path of wires()!.querySelectorAll("path")) expect(path.getAttribute("style")).toBeNull();

    vi.useFakeTimers();
    await act(async () => fireEvent.click(commentsButton()));
    expect(document.documentElement.dataset.rail).toBe("collapsed");
  });

  it("retracts connectors before a pinned rail collapses", async () => {
    reducedMotion = false;
    // happy-dom has no SVG geometry.
    Object.defineProperty(SVGElement.prototype, "getTotalLength", { value: () => 100, configurable: true });
    localStorage.setItem("rr-connectors", "on");
    await renderPage();
    await vi.waitFor(() => expect(wires()).toBeTruthy());

    vi.useFakeTimers();
    await act(async () => fireEvent.click(commentsButton()));
    expect(document.documentElement.dataset.rail).toBe("pinned");
    const path = wires()!.querySelector("path")!;
    expect(path.style.transition).toMatch(/stroke-dashoffset/);

    await act(async () => vi.advanceTimersByTimeAsync(240));
    expect(document.documentElement.dataset.rail).toBe("collapsed");
    await act(async () => vi.runAllTimersAsync());
    expect(wires()).toBeNull();
    delete (SVGElement.prototype as { getTotalLength?: unknown }).getTotalLength;
  });
});

describe("margin markers", () => {
  it("appear only while the rail is collapsed, one per aligned thread, labelled by state", async () => {
    await renderPage();
    expect(screen.queryByRole("button", { name: /Open in comment rail/ })).toBeNull();

    await userEvent.click(commentsButton());
    const markers = within(article()).getAllByRole("button", { name: /Open in comment rail/ });
    expect(markers.map((m) => m.getAttribute("aria-label"))).toEqual([
      "1 comment, current. Open in comment rail",
      "2 comments, resolved. Open in comment rail",
    ]);
    for (const m of markers) expect(m.getAttribute("aria-controls")).toBe("rr-rail");
  });

  it("follow the filters", async () => {
    localStorage.setItem("rr-rail", "collapsed");
    await renderPage();
    await userEvent.click(chip(/^Resolved/));
    expect(screen.queryByRole("button", { name: /resolved\. Open in comment rail/ })).toBeNull();
  });

  it("open the slide-over focused on their thread", async () => {
    localStorage.setItem("rr-rail", "collapsed");
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: /^2 comments, resolved/ }));
    expect(document.documentElement.dataset.rail).toBe("slide");
    const card = document.getElementById(threadDomId("resolved")) as HTMLDetailsElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(card));
    expect(card.open).toBe(true);
  });
});
