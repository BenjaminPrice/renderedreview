// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import type { SourceSelection } from "@rendered-review/markdown-domain";
import type { Representation } from "@rendered-review/review-domain";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublishError } from "../github/mutations";
import { expectNewTab } from "../test-utils";
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
  render(<Composer selection={selection} representation={native} signedIn {...handlers} {...props} />);
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

describe("an organization restricting the OAuth App", () => {
  it("explains it and links to where approval is requested, keeping the text and Add to review", async () => {
    window.history.replaceState(null, "", "/github.com/acme/widgets/pull/7?file=README.md");
    const { onCommentNow, onAddToReview } = mount();
    const refusal = new PublishError(403, {
      code: "oauth-org-restricted",
      message: "The Call-for-Code organization restricts third-party apps",
      org: "Call-for-Code",
      approvalUrl: "https://github.com/settings/connections/applications/Ov23abc",
    });
    onCommentNow.mockRejectedValueOnce(new Error(refusal.message, { cause: refusal }));
    await userEvent.type(textarea(), "Good find!");
    await userEvent.click(screen.getByRole("button", { name: "Comment now" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The Call-for-Code organization restricts third-party apps.").tagName).toBe(
      "STRONG",
    );
    expect(alert.textContent).toContain(
      "An organization owner needs to approve Rendered Review, or install the Rendered Review GitHub App",
    );
    const link = within(alert).getByRole("link", { name: /Request approval/ });
    expect(link.getAttribute("href")).toBe("https://github.com/settings/connections/applications/Ov23abc");
    expectNewTab(link);
    // Installing happens in a new tab (keeping this draft) that returns to this pull request.
    const install = within(alert).getByRole("link", { name: /install the Rendered Review GitHub App/ });
    expect(install.getAttribute("href")).toBe(
      `/api/github/install?return=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    );
    expectNewTab(install);
    expect(textarea()).toHaveProperty("value", "Good find!");
    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));
    expect(onAddToReview).toHaveBeenCalledWith("Good find!");
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

describe("suggesting", () => {
  const original = "Each delay includes full jitter of up to 20%.";
  const replacement = () => screen.getByRole("textbox", { name: "Replacement" });
  const suggestTab = () => screen.getByRole("button", { name: "Suggest" });

  it("prefills the replacement with the whole source lines, previews the change and adds it", async () => {
    const { onAddToReview, card } = mount({ original });
    await userEvent.click(suggestTab());
    expect(suggestTab().getAttribute("aria-pressed")).toBe("true");
    expect(within(card).getByText("Suggesting a replacement for line 24")).toBeTruthy();
    expect(replacement()).toHaveProperty("value", original);
    expect(screen.getByRole("textbox", { name: "Comment (optional)" })).toBeTruthy();

    // Nothing changed yet: nothing to suggest.
    const add = screen.getByRole("button", { name: "Add to review" });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(within(card).getByText("Edit the replacement to suggest a change.")).toBeTruthy();

    await userEvent.clear(replacement());
    await userEvent.type(replacement(), "Each delay includes `equal` jitter.");
    const preview = within(card).getByRole("group", { name: "Preview of the change" });
    expect([...preview.querySelectorAll(".rr-diff-del, .rr-diff-add")].map((row) => row.textContent)).toEqual([
      `Removed: ${original}`,
      "Added: Each delay includes `equal` jitter.",
    ]);
    await userEvent.click(add);
    expect(onAddToReview).toHaveBeenCalledWith("", "Each delay includes `equal` jitter.");
  });

  it("says a suggestion on head diff lines posts natively, and elsewhere must be applied manually", async () => {
    mount({ original });
    await userEvent.click(suggestTab());
    expect(screen.getByText(/authors can apply it/).closest("p")!.textContent).toBe(
      "Will post as a native suggestion · authors can apply it on GitHub",
    );
    cleanup();
    mount({ original, representation: { kind: "review-file", reason: "Will post as file comment · x" } });
    await userEvent.click(suggestTab());
    expect(screen.getByText(/must be applied manually/).closest("p")!.textContent).toBe(
      "Will post as a proposed change · it must be applied manually",
    );
  });

  it("covers every line of a multi-line selection", async () => {
    mount({
      original: "a\nb\nc",
      selection: { ...selection, sourceRange: { startLine: 22, startColumn: 3, endLine: 25, endColumn: 1 } },
    });
    await userEvent.click(suggestTab());
    expect(screen.getByText("Suggesting a replacement for lines 22–24")).toBeTruthy();
    expect(replacement()).toHaveProperty("value", "a\nb\nc");
  });

  it("publishes a suggestion now, with the optional comment", async () => {
    const { onCommentNow } = mount({ original, suggest: true });
    await userEvent.type(replacement(), " More.");
    await userEvent.type(screen.getByRole("textbox", { name: "Comment (optional)" }), "Clearer?");
    await userEvent.click(screen.getByRole("button", { name: "Comment now" }));
    expect(onCommentNow).toHaveBeenCalledWith("Clearer?", `${original} More.`);
  });

  it("goes back to a plain comment on the Comment tab", async () => {
    const { onAddToReview } = mount({ original, suggest: true });
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    await userEvent.type(textarea(), "Just a note");
    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));
    expect(onAddToReview).toHaveBeenCalledWith("Just a note");
  });

  it("edits a suggestion draft from its replacement", async () => {
    const { onAddToReview } = mount({ original, editing: true, initial: "Why", initialReplacement: "New text" });
    expect(suggestTab().getAttribute("aria-pressed")).toBe("true");
    expect(replacement()).toHaveProperty("value", "New text");
    await userEvent.type(replacement(), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(onAddToReview).toHaveBeenCalledWith("Why", "New text!");
  });

  it("is unavailable without the source lines or when signed out", () => {
    mount();
    expect(suggestTab().getAttribute("aria-disabled")).toBe("true");
    cleanup();
    mount({ original, signedIn: false });
    expect(suggestTab().getAttribute("aria-disabled")).toBe("true");
  });
});
