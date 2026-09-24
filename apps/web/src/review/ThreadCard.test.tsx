// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { comment, lineAnchor, OLD, repository, thread } from "./fixtures";
import { expectNewTab } from "../test-utils";
import type { ThreadActions } from "./thread-actions";
import { ThreadCard } from "./ThreadCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

function withActions(t: Parameters<typeof ThreadCard>[0]["thread"], over: Partial<ThreadActions> = {}) {
  const actions: ThreadActions = {
    signedIn: true,
    onSignIn: vi.fn(),
    reply: vi.fn(async () => {}),
    setResolved: vi.fn(async () => {}),
    ...over,
  };
  const view = render(<ThreadCard thread={t} repository={repository} actions={actions} />);
  const rerender = (next: typeof t) =>
    view.rerender(<ThreadCard thread={next} repository={repository} actions={actions} />);
  return { actions, rerender };
}

const REPLY = "Reply to thread by alice, GitHub line comment · L3";

describe("replies", () => {
  it("opens a reply box with focus in it, sends with Ctrl+Enter and returns focus to Reply", async () => {
    const t = thread("t1", lineAnchor(3), "unresolved");
    const { actions } = withActions(t);
    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    const box = screen.getByRole("textbox", { name: "Reply to thread by alice" });
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, "Thanks{Control>}{Enter}{/Control}");
    expect(actions.reply).toHaveBeenCalledWith(t, "Thanks");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: REPLY }));
  });

  it("previews the reply as Markdown", async () => {
    withActions(thread("t1", lineAnchor(3), "unresolved"));
    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    await userEvent.type(screen.getByRole("textbox"), "Very **bold**");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("cancels on Escape, asking before discarding what was written", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    withActions(thread("t1", lineAnchor(3), "unresolved"));
    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    await userEvent.keyboard("{Escape}");
    expect(confirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: REPLY }));

    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    await userEvent.type(screen.getByRole("textbox"), "Half a thought");
    await userEvent.keyboard("{Escape}");
    expect(confirm).toHaveBeenCalledWith("Discard this reply?");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Half a thought");
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("sends once while a reply is being posted", async () => {
    let finish!: () => void;
    const reply = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    withActions(thread("t1", lineAnchor(3), "unresolved"), { reply });
    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    await userEvent.type(screen.getByRole("textbox"), "Once");
    const send = screen.getByRole("button", { name: "Reply" });
    await userEvent.click(send);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(send).toHaveProperty("disabled", true);
    expect(reply).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not send an empty reply", async () => {
    const { actions } = withActions(thread("t1", lineAnchor(3), "unresolved"));
    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    expect(screen.getByRole("button", { name: "Reply" })).toHaveProperty("disabled", true);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(actions.reply).not.toHaveBeenCalled();
  });

  it("shows a refusal inline and keeps the text", async () => {
    const reply = vi.fn(async () => {
      throw new Error("GitHub's rate limit was reached. Try again later.");
    });
    withActions(thread("t1", lineAnchor(3), "unresolved"), { reply });
    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    await userEvent.type(screen.getByRole("textbox"), "Try");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect((await screen.findByRole("alert")).textContent).toBe("GitHub's rate limit was reached. Try again later.");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Try");
  });

  it("says where an application thread's reply goes", async () => {
    withActions(thread("app:1", lineAnchor(3), "unresolved"));
    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    expect(screen.getByText("Will post as PR conversation comment")).toBeTruthy();
  });

  it("offers sign-in instead of reply and resolve to signed-out readers", async () => {
    const { actions } = withActions(thread("app:1", lineAnchor(3), "unresolved"), { signedIn: false });
    await userEvent.click(screen.getByRole("button", { name: "Sign in to reply" }));
    expect(actions.onSignIn).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^(Reply|Resolve)/ })).toBeNull();
  });

  it("shows no reply controls when sign-in isn't offered", () => {
    withActions(thread("t1", lineAnchor(3), "unknown"), { signedIn: false, onSignIn: undefined });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("resolution controls", () => {
  it("resolves an open thread and moves focus to it once it collapses", async () => {
    const t = thread("t1", lineAnchor(3), "unresolved");
    const { actions, rerender } = withActions(t);
    await userEvent.click(screen.getByRole("button", { name: "Resolve thread by alice, GitHub line comment · L3" }));
    expect(actions.setResolved).toHaveBeenCalledWith(t, true);
    rerender({ ...t, resolution: "resolved" });
    expect(document.activeElement).toBe(screen.getByText("Resolved").closest("summary"));
  });

  it("reopens a resolved thread", async () => {
    const t = thread("t1", lineAnchor(3), "resolved");
    const { actions } = withActions(t);
    await userEvent.click(screen.getByText("Resolved").closest("summary")!);
    await userEvent.click(screen.getByRole("button", { name: "Reopen thread by alice, GitHub line comment · L3" }));
    expect(actions.setResolved).toHaveBeenCalledWith(t, false);
  });

  it("resolves once while pending and shows a refusal inline", async () => {
    let fail!: (e: Error) => void;
    const setResolved = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    withActions(thread("t1", lineAnchor(3), "unresolved"), { setResolved });
    const resolve = screen.getByRole("button", { name: /^Resolve thread/ });
    await userEvent.click(resolve);
    await userEvent.click(resolve);
    expect(setResolved).toHaveBeenCalledTimes(1);
    expect(resolve.getAttribute("aria-disabled")).toBe("true");
    await act(async () => fail(new Error("Your GitHub sign-in has expired. Sign in again, then retry.")));
    expect(screen.getByRole("alert").textContent).toBe("Your GitHub sign-in has expired. Sign in again, then retry.");
    expect(resolve.getAttribute("aria-disabled")).toBeNull();
  });

  it("explains why a thread can't be resolved when its state is unknown", async () => {
    const { actions } = withActions(thread("t1", lineAnchor(3), "unknown"));
    const resolve = screen.getByRole("button", { name: /^Resolve thread/ });
    expect(resolve.getAttribute("aria-disabled")).toBe("true");
    expect(resolve.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(resolve.getAttribute("aria-describedby")!)!.textContent).toBe(
      "GitHub didn't report whether this thread is resolved.",
    );
    await userEvent.click(resolve);
    expect(actions.setResolved).not.toHaveBeenCalled();
  });

  it("hides Resolve while a reply is being written, so the card can't collapse over it", async () => {
    withActions(thread("t1", lineAnchor(3), "unresolved"));
    await userEvent.click(screen.getByRole("button", { name: REPLY }));
    expect(screen.queryByRole("button", { name: /^Resolve/ })).toBeNull();
  });
});
