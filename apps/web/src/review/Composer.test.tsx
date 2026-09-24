// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import type { SourceSelection } from "@rendered-review/markdown-domain";
import type { Representation } from "@rendered-review/review-domain";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const selection: SourceSelection = {
  exact: "full jitter of up to 20%",
  prefix: "",
  suffix: "",
  textPosition: { start: 10, end: 34 },
  sourceRange: { startLine: 24, startColumn: 5, endLine: 24, endColumn: 29 },
  nodeType: "paragraph",
  headingPath: [],
  blockIds: [3],
  expanded: false,
};
const native: Representation = {
  kind: "review-line",
  line: 24,
  side: "RIGHT",
  reason: "Will post as native review comment · line 24 is in this PR's diff",
};

function mount(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const handlers = {
    onAddToReview: vi.fn(),
    onCommentNow: vi.fn(async () => {}),
    onCancel: vi.fn(),
    onSignIn: vi.fn(),
  };
  render(<Composer selection={selection} representation={native} signedIn canPublish {...handlers} {...props} />);
  return { ...handlers, card: screen.getByRole("region", { name: /New comment|Edit draft/ }) };
}

const textarea = () => screen.getByRole("textbox", { name: "Comment" });

describe("composing", () => {
  it("opens focused on the comment box, quoting the selection and saying where it will post", () => {
    const { card } = mount();
    expect(document.activeElement).toBe(textarea());
    expect(within(card).getByText("full jitter of up to 20%").tagName).toBe("BLOCKQUOTE");
    const hint = within(card)
      .getByText(/line 24 is in this PR's diff/)
      .closest("p")!;
    expect(hint.textContent).toBe("Will post as native review comment · line 24 is in this PR's diff");
    expect(within(hint).getByText("Will post as native review comment").tagName).toBe("B");
  });

  it.each([
    ["review-file", "Will post as file comment · line 24 isn't in the diff"],
    ["conversation", "Will post as PR conversation comment · file isn't changed in this PR"],
  ] as const)("explains a %s representation", (kind, reason) => {
    mount({ representation: { kind, reason } });
    expect(screen.getByText(new RegExp(reason.split(" · ")[1]!)).closest("p")!.textContent).toBe(reason);
  });

  it("says when a selection across blocks covers whole blocks", () => {
    mount({
      selection: {
        ...selection,
        expanded: true,
        sourceRange: { startLine: 3, startColumn: 1, endLine: 7, endColumn: 10 },
      },
    });
    expect(screen.getByText("Comment covers lines 3–7 · whole blocks")).toBeTruthy();
  });

  it("adds the comment to the review, by button or Ctrl/Cmd+Enter", async () => {
    const { onAddToReview } = mount();
    const add = screen.getByRole("button", { name: "Add to review" });
    expect(add.hasAttribute("disabled")).toBe(true);
    await userEvent.type(textarea(), "Which jitter?");
    await userEvent.click(add);
    expect(onAddToReview).toHaveBeenLastCalledWith("Which jitter?");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onAddToReview).toHaveBeenCalledTimes(3);
  });

  it("previews the comment as rendered Markdown", async () => {
    mount();
    await userEvent.type(textarea(), "Use **full** jitter");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("full").tagName).toBe("STRONG");
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(textarea()).toHaveProperty("value", "Use **full** jitter");
  });

  it("cancels on Escape, confirming first when something was written", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { onCancel } = mount();
    await userEvent.keyboard("{Escape}");
    expect(confirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);

    await userEvent.type(textarea(), "Draft text");
    await userEvent.keyboard("{Escape}");
    expect(confirm).toHaveBeenCalledWith("Discard this comment?");
    expect(onCancel).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("refuses a selection it cannot encode, asking for a narrower one", () => {
    mount({ error: "This selection is too long to comment on. Select a shorter passage." });
    expect(screen.getByRole("alert").textContent).toBe(
      "This selection is too long to comment on. Select a shorter passage.",
    );
    expect(screen.getByRole("button", { name: "Add to review" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("publishing now", () => {
  it("is unavailable, saying so, until publishing exists", () => {
    mount({ canPublish: false });
    const now = screen.getByRole("button", { name: "Comment now" });
    expect(now.hasAttribute("disabled")).toBe(true);
    expect(now.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(now.getAttribute("aria-describedby")!)!.textContent).toMatch(/coming soon/);
  });

  it("publishes, and keeps the text with the reason when it fails", async () => {
    const { onCommentNow } = mount();
    onCommentNow.mockRejectedValueOnce(new Error("The pull request changed since this page loaded."));
    await userEvent.type(textarea(), "Which jitter?");
    await userEvent.click(screen.getByRole("button", { name: "Comment now" }));
    expect(onCommentNow).toHaveBeenCalledWith("Which jitter?");
    expect((await screen.findByRole("alert")).textContent).toBe("The pull request changed since this page loaded.");
    expect(textarea()).toHaveProperty("value", "Which jitter?");
  });
});

describe("editing a draft", () => {
  it("starts from the draft's text and saves it", async () => {
    const { onAddToReview } = mount({ initial: "Old text", editing: true });
    expect(textarea()).toHaveProperty("value", "Old text");
    expect(screen.queryByRole("button", { name: "Comment now" })).toBeNull();
    await userEvent.type(textarea(), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(onAddToReview).toHaveBeenCalledWith("Old text!");
  });
});

describe("signed out", () => {
  it("offers sign-in instead of a comment box", async () => {
    const { onSignIn, card } = mount({ signedIn: false });
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(within(card).getByText("full jitter of up to 20%")).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Sign in to comment" }));
    expect(onSignIn).toHaveBeenCalled();
  });
});
