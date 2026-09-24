// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { comment, lineAnchor, OLD, repository, thread } from "./fixtures";
import { ThreadCard } from "./ThreadCard";

afterEach(cleanup);

const card = (t: Parameters<typeof ThreadCard>[0]["thread"]) =>
  render(<ThreadCard thread={t} repository={repository} />).container.firstElementChild as HTMLElement;

describe("location labels", () => {
  it("labels a line range as a GitHub line comment, never a word selection", () => {
    const el = card(thread("t1", lineAnchor(3, 5)));
    expect(screen.getByRole("region", { name: "GitHub line comment · L3–L5, by alice" })).toBe(el);
    expect(within(el).getByText("GitHub line comment · L3–L5")).toBeTruthy();
    expect(el.textContent).not.toMatch(/selection|word/i);
  });

  it("labels a file-level comment", () => {
    card(thread("t1", { type: "file" }));
    expect(screen.getByRole("region", { name: "File-level review comment, by alice" })).toBeTruthy();
    expect(screen.getByText("File-level review comment")).toBeTruthy();
  });

  it("shows an outdated thread's original commit and links to the original lines", () => {
    card(thread("t1", lineAnchor(3, 5, "outdated", OLD)));
    expect(screen.getByRole("region", { name: /, outdated$/ })).toBeTruthy();
    expect(screen.getByText("Outdated")).toBeTruthy();
    const loc = screen.getByText(/^From/);
    expect(loc.textContent).toBe(`From ${OLD.slice(0, 7)} · L3–L5`);
    expect(screen.getByRole("link", { name: "View in original" }).getAttribute("href")).toBe(
      `https://github.com/acme/docs/blob/${OLD}/docs/guide.md#L3-L5`,
    );
  });

  it("links every thread to GitHub", () => {
    const root = comment();
    card(thread("t1", lineAnchor(3), "unknown", [root]));
    expect(screen.getByRole("link", { name: "View on GitHub" }).getAttribute("href")).toBe(root.htmlUrl);
  });
});

describe("comment metadata", () => {
  it("marks comments edited on GitHub, but not GitHub's creation-time bump", () => {
    card(
      thread("t1", lineAnchor(3), "unknown", [
        comment({ body: "first", updatedAt: "2026-01-01T00:00:02Z" }),
        comment({ body: "second", updatedAt: "2026-01-02T00:00:00Z" }),
      ]),
    );
    expect(screen.getAllByText("Edited on GitHub")).toHaveLength(1);
  });

  it("claims no resolution when GitHub did not report one", () => {
    card(thread("t1", lineAnchor(3), "unknown"));
    expect(screen.queryByText("Unresolved")).toBeNull();
    expect(screen.queryByText("Resolved")).toBeNull();
  });

  it("badges an unresolved thread", () => {
    card(thread("t1", lineAnchor(3), "unresolved"));
    expect(screen.getByText("Unresolved")).toBeTruthy();
  });
});

describe("suggestions", () => {
  it("shows a suggestion as a proposed change with a GitHub link and no apply button", () => {
    const c = comment({ body: "```suggestion\nTHREE\n```", diffHunk: "@@ -1,3 +1,3 @@\n one\n two\n+three" });
    card(thread("t1", lineAnchor(3), "unknown", [c]));
    const change = screen.getByRole("group", { name: "Suggested change" });
    expect(within(change).getByText(/three$/).textContent).toBe("Removed: three");
    expect(within(change).getByText(/THREE$/).textContent).toBe("Added: THREE");
    expect(within(change).getByRole("link").getAttribute("href")).toBe(c.htmlUrl);
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
  });
});

describe("comment bodies", () => {
  it("renders Markdown but leaves script and event-handler payloads inert", () => {
    const body = 'Hi **there** <script>window.pwned = 1</script><img src="x" onerror="window.pwned = 1">';
    const el = card(thread("t1", lineAnchor(3), "unknown", [comment({ body })]));
    expect(within(el).getByText("there").tagName).toBe("STRONG");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("[onerror]")).toBeNull();
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe("resolved threads", () => {
  it("collapse in place and expand on demand", async () => {
    const el = card(
      thread("t1", lineAnchor(3), "resolved", [comment({ body: "Fix this" }), comment({ body: "Done" })]),
    );
    const summary = screen.getByText("Resolved").closest("summary")!;
    expect(summary.getAttribute("aria-label")).toBe(
      "Resolved thread by alice, 2 comments. GitHub line comment · L3",
    );
    expect((el as HTMLDetailsElement).open).toBe(false);
    await userEvent.click(summary);
    expect((el as HTMLDetailsElement).open).toBe(true);
    expect(within(el).getByText("Done")).toBeTruthy();
  });
});
