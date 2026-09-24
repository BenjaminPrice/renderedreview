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
import { CommentRail, type CommentRailProps, RailHeader } from "./CommentRail";
import { appThread, comment, issueComment, lineAnchor, OLD, repository, thread } from "./fixtures";
import { DEFAULT_FILTERS, placementCounts } from "./model";
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

function Page({ items = placements, originalLink }: { items?: ThreadPlacement[] } & Partial<CommentRailProps>) {
  const docRef = useRef<HTMLElement>(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  return (
    <AppShell
      commentCount={items.length}
      railHeader={<RailHeader counts={placementCounts(items)} filters={filters} onFiltersChange={setFilters} />}
      rail={
        <CommentRail
          placements={items}
          repository={repository}
          filters={filters}
          docContainerRef={docRef}
          originalLink={originalLink}
        />
      }
    >
      <article ref={docRef} aria-label="Rendered document" style={{ paddingRight: 48 }}>
        <p data-rr-id="1">First paragraph</p>
        <p data-rr-id="2">Second paragraph</p>
      </article>
    </AppShell>
  );
}

const renderPage = (items?: ThreadPlacement[], props: Partial<CommentRailProps> = {}) =>
  renderWithRouter(() => <Page items={items} {...props} />);
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
  // The shell's top bar asks who is signed in; no sign-in here.
  vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404 }));
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

  it("files threads whose words are only in an earlier revision under Historical", async () => {
    const reanchor = { state: "historical-only", evidence: "none", confidence: 0, candidates: [] } as const;
    const reason = "The quoted text is only in an earlier revision";
    await renderPage([...placements, { thread: appThread([issueComment("Gone one")]), blocks: [], reason, reanchor }]);
    expect(chip(/^Historical/).textContent).toBe("Historical 1");
    expect(within(rail()).queryByText("Gone one")).toBeNull();
    await userEvent.click(chip(/^Historical/));
    const card = within(rail()).getByText("Gone one").closest("section")!;
    expect(card.getAttribute("aria-label")).toMatch(/, historical$/);
  });

  it("links threads not shown as written to their original revision", async () => {
    const originalLink = vi.fn((_thread, commitOid: string) => ({ href: `/somewhere?rev=${commitOid}` }));
    await renderPage(undefined, { originalLink });
    const old = within(rail()).getByText("Old one").closest("section")!;
    expect(within(old).getByRole("link", { name: "View in original" }).getAttribute("href")).toBe(
      `/somewhere?rev=${OLD}`,
    );
    const current = within(rail()).getByText("Current one").closest("section")!;
    expect(within(current).queryByRole("link", { name: /View in original/ })).toBeNull();
  });

  it("keeps resolved threads collapsed in place", async () => {
    await renderPage();
    const resolved = within(rail()).getByText("Resolved one").closest("details")!;
    expect(resolved.open).toBe(false);
    expect(within(rail()).getByText("Current one")).toBeTruthy();
  });

  it("lists file-level and outdated threads as not placed, apart from the aligned ones", async () => {
    await renderPage();
    const group = within(rail()).getByRole("region", { name: "Not placed in document" });
    expect(within(group).getByText("File one")).toBeTruthy();
    expect(within(group).getByText("Old one")).toBeTruthy();
  });

  it("shows verified application threads without their quote, and says why others are not placed", async () => {
    const placed = appThread([issueComment("Placed one")]);
    const pending = appThread([issueComment("Pending one")]);
    const damaged = appThread([issueComment("Damaged one")]);
    const range = {
      kind: "annotation" as const,
      sourceRange: { startLine: 3, startColumn: 12, endLine: 3, endColumn: 35 },
      textQuote: { exact: "retries failed requests" },
    };
    await renderPage([
      { thread: placed, blocks: [block(1)], range },
      { thread: pending, blocks: [], reason: "The quoted text now appears in 2 places" },
      { thread: damaged, blocks: [], damaged: "The quoted text does not match" },
    ]);
    const aligned = within(rail()).getByText("Placed one").closest("section")!;
    expect(aligned.querySelector("blockquote")).toBeNull();
    const group = within(rail()).getByRole("region", { name: "Not placed in document" });
    expect(within(group).getByText(/now appears in 2 places$/)).toBeTruthy();
    expect(within(group).getByText("Metadata damaged")).toBeTruthy();
    expect(within(group).getAllByText("retries failed requests")).toHaveLength(2);
  });

  it("shows a thread re-anchored from an earlier revision at its new lines, marked moved", async () => {
    const moved = appThread([issueComment("Moved one")]);
    const sourceRange = { startLine: 5, startColumn: 12, endLine: 5, endColumn: 35 };
    const range = { kind: "annotation" as const, sourceRange, textQuote: { exact: "retries failed requests" } };
    const reanchor = {
      state: "moved" as const,
      evidence: "quote-context" as const,
      confidence: 0.95,
      sourceRange,
      candidates: [],
    };
    await renderPage([{ thread: moved, blocks: [block(1)], range, reanchor }]);
    const card = within(rail()).getByRole("region", { name: "Selected text · L5, by alice, moved" });
    expect(within(card).getByText("Moved")).toBeTruthy();
    expect(within(card).getByText("retries failed requests")).toBeTruthy();
  });

  it("marks an approximately re-anchored thread's location as approximate", async () => {
    const moved = appThread([issueComment("Approximate one")]);
    const sourceRange = { startLine: 5, startColumn: 1, endLine: 5, endColumn: 40 };
    const reanchor = {
      state: "moved" as const,
      evidence: "structure" as const,
      confidence: 0.7,
      approximate: true as const,
      sourceRange,
      candidates: [],
    };
    await renderPage([{ thread: moved, blocks: [block(1)], reanchor }]);
    const card = within(rail()).getByRole("region", { name: "Selected text · L5, by alice, moved" });
    expect(within(card).getByText(/approximate location$/)).toBeTruthy();
    expect(within(card).getByText("retries failed requests")).toBeTruthy();
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
