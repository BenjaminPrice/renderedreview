// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { appThread, comment, issueComment, lineAnchor, OLD, repository, thread } from "./fixtures";
import { expectNewTab } from "../test-utils";
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
    const original = screen.getByRole("link", { name: "View in original (opens in new tab)" });
    expectNewTab(original);
    expect(original.getAttribute("href")).toBe(`https://github.com/acme/docs/blob/${OLD}/docs/guide.md#L3-L5`);
  });

  it("links every thread to GitHub", () => {
    const root = comment();
    card(thread("t1", lineAnchor(3), "unknown", [root]));
    const link = screen.getByRole("link", { name: "View on GitHub (opens in new tab)" });
    expectNewTab(link);
    expect(link.getAttribute("href")).toBe(root.htmlUrl);
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
    const apply = within(change).getByRole("link", { name: "Apply on GitHub (opens in new tab)" });
    expectNewTab(apply);
    expect(apply.getAttribute("href")).toBe(c.htmlUrl);
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
    expect(summary.getAttribute("aria-label")).toBe("Resolved thread by alice, 2 comments. GitHub line comment · L3");
    expect((el as HTMLDetailsElement).open).toBe(false);
    await userEvent.click(summary);
    expect((el as HTMLDetailsElement).open).toBe(true);
    expect(within(el).getByText("Done")).toBeTruthy();
  });
});

describe("application threads", () => {
  const REANCHOR = "Document changed since this comment — re-anchoring pending";

  it("labels the selected words and hides the repeated quote once the anchor is verified", () => {
    const el = render(<ThreadCard thread={appThread()} repository={repository} verified />).container;
    expect(screen.getByRole("region", { name: "Selected text · L3, by alice" })).toBeTruthy();
    expect(within(el as HTMLElement).getByText("Needs a retry limit.")).toBeTruthy();
    expect(el.querySelector("blockquote")).toBeNull();
    expect(el.textContent).not.toContain("Document:");
  });

  it("shows the whole body and why it is not placed while the document has changed", () => {
    const el = render(<ThreadCard thread={appThread()} repository={repository} unplaced reason={REANCHOR} />).container;
    expect(el.querySelector("blockquote")?.textContent?.trim()).toBe("retries failed requests");
    expect(screen.getByText(`Selected text · L3 · ${REANCHOR}`)).toBeTruthy();
  });

  it("shows resolve and reopen as small events, not as comments", () => {
    const [root, resolve, reopen] = [
      issueComment("Needs a retry limit."),
      issueComment("Resolved", { author: { login: "bob", id: 2, nodeId: "U2", type: "User" } }),
      issueComment("Reopened"),
    ];
    const t = appThread([root], {
      events: [
        { resolution: "resolved", at: "2026-01-02T00:00:00Z", comment: resolve },
        { resolution: "reopened", at: "2026-01-03T00:00:00Z", comment: reopen },
      ],
    });
    render(<ThreadCard thread={t} repository={repository} verified />);
    const events = screen.getByRole("list", { name: "Thread events" });
    expect(
      within(events)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringMatching(/^bob resolved this thread/),
      expect.stringMatching(/^alice reopened this thread/),
    ]);
    expect(screen.queryByText("Resolved")).toBeNull();
  });
});

describe("metadata notices", () => {
  it("badges damaged and unsupported metadata on the comment, keeping its whole body", () => {
    const [damaged, unsupported] = [comment({ body: "> quote\n\nFirst" }), comment({ body: "Second" })];
    const t = thread("t1", lineAnchor(3), "unknown", [damaged, unsupported]);
    t.metadata = {
      [damaged.id]: { state: "damaged", reason: "The metadata names another pull request", edited: false },
      [unsupported.id]: { state: "unsupported", reason: "Unsupported annotation version 2", edited: false },
    };
    const el = card(t);
    expect(screen.getByText("Metadata damaged").closest("[title]")?.getAttribute("title")).toBe(
      "The metadata names another pull request",
    );
    expect(screen.getByText("Unsupported version")).toBeTruthy();
    expect(el.querySelector("blockquote")).toBeTruthy();
  });

  it("badges an annotation that does not match its document", () => {
    render(<ThreadCard thread={appThread()} repository={repository} damaged="The quoted text does not match" />);
    expect(screen.getByText("Metadata damaged")).toBeTruthy();
  });
});
