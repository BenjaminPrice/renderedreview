// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import type { Representation } from "@rendered-review/review-domain";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "./drafts";
import type { Publisher } from "./publish";
import { DraftCard } from "./DraftCard";
import { SubmitReview } from "./SubmitReview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEAD = "a".repeat(40);
const OLD = "0".repeat(40);
const line = (n: number): Representation => ({
  kind: "review-line",
  line: n,
  side: "RIGHT",
  reason: "Will post as native review comment · x",
});
const draft = (id: string, representation: Representation, headOid = HEAD, path = "docs/retry.md"): Draft =>
  ({
    id,
    headOid,
    path,
    representation,
    comment: `Comment ${id}`,
    body: `> quote\n\nComment ${id}`,
    selection: { exact: `quote ${id}`, sourceRange: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 9 } },
  }) as Draft;

const drafts = [
  draft("d1", line(3)),
  draft("d2", { kind: "review-file", reason: "Will post as file comment · x" }),
  draft("d3", { kind: "conversation", reason: "Will post as PR conversation comment · x" }, HEAD, "README.md"),
  draft("d4", line(9)),
];

const idle: Publisher = { publishComment: vi.fn(), submitReview: vi.fn(async () => []) };

function mount(props: { drafts?: Draft[]; publisher?: Publisher } = {}) {
  const onPublished = vi.fn();
  const onClose = vi.fn();
  render(
    <SubmitReview
      drafts={props.drafts ?? drafts}
      headOid={HEAD}
      publisher={props.publisher ?? idle}
      onPublished={onPublished}
      onClose={onClose}
    />,
  );
  return { onPublished, onClose, dialog: screen.getByRole("dialog", { name: "Submit review" }) };
}

describe("submit review dialog", () => {
  it("lists drafts grouped by where they will post", () => {
    const { dialog } = mount();
    const group = (name: RegExp) => within(dialog).getByRole("group", { name });
    expect(
      within(group(/^Native review comments/))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("Comment d1"), expect.stringContaining("Comment d4")]);
    expect(within(group(/^File comments/)).getByRole("listitem").textContent).toContain("Comment d2");
    expect(within(group(/^PR conversation comments/)).getByRole("listitem").textContent).toContain("README.md");
  });

  it("submits intents with the summary and verdict, removing published drafts and reporting failures", async () => {
    const submitReview = vi.fn(async (intents: { id: string }[]) =>
      intents.map(({ id }) =>
        id === "d3"
          ? { draftId: id, ok: false as const, message: "GitHub refused it" }
          : { draftId: id, ok: true as const },
      ),
    );
    const { dialog, onPublished, onClose } = mount({ publisher: { publishComment: vi.fn(), submitReview } });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Summary (optional)" }), "Looks good");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Request changes" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Submit review" }));

    const [intents, summary, verdict] = submitReview.mock.calls[0]! as unknown as [unknown[], string, string];
    expect(summary).toBe("Looks good");
    expect(verdict).toBe("REQUEST_CHANGES");
    expect(intents).toContainEqual({
      id: "d1",
      body: "> quote\n\nComment d1",
      expectedHeadOid: HEAD,
      representation: "review-line",
      path: "docs/retry.md",
      line: 3,
      side: "RIGHT",
    });
    expect(intents).toContainEqual({
      id: "d3",
      body: "> quote\n\nComment d3",
      expectedHeadOid: HEAD,
      representation: "conversation",
    });
    expect(onPublished).toHaveBeenCalledWith(["d1", "d2", "d4"]);
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /3 published.*1 not published.*README\.md.*GitHub refused it/s,
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("requires confirmation before publishing drafts written against an older head", async () => {
    const submitReview = vi.fn(async () => []);
    const { dialog } = mount({
      drafts: [draft("d1", line(3)), draft("old", line(5), OLD)],
      publisher: { publishComment: vi.fn(), submitReview },
    });
    expect(within(dialog).getByText(/1 draft was written against an older version/)).toBeTruthy();
    expect(within(dialog).getByText("Stale")).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: "Submit review" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Publish stale drafts anyway/ }));
    await userEvent.click(submit);
    expect(submitReview).toHaveBeenCalled();
  });

  it("needs a summary or a draft to leave a plain comment review, but not to approve", async () => {
    const publisher = { publishComment: vi.fn(), submitReview: vi.fn(async () => []) };
    const { dialog } = mount({ drafts: [], publisher });
    const submit = within(dialog).getByRole("button", { name: "Submit review" });
    expect(within(dialog).getByText("No drafts yet. Add comments to the review from the document.")).toBeTruthy();
    expect(submit.hasAttribute("disabled")).toBe(true);
    await userEvent.click(within(dialog).getByRole("radio", { name: "Approve" }));
    expect(submit.hasAttribute("disabled")).toBe(false);
  });
});

describe("draft card", () => {
  it("shows the draft with its quote and where it will post; edits and deletes it", async () => {
    vi.stubGlobal("confirm", () => true);
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<DraftCard draft={drafts[0]!} stale={false} onEdit={onEdit} onDelete={onDelete} />);
    const card = screen.getByRole("region", { name: "Draft comment on line 3" });
    expect(within(card).getByText("Draft")).toBeTruthy();
    expect(within(card).getByText("quote d1").tagName).toBe("BLOCKQUOTE");
    expect(within(card).getByText("Comment d1")).toBeTruthy();
    expect(within(card).getByText("Will post as native review comment")).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalled();
    await userEvent.click(within(card).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalled();
  });

  it("marks a draft written against an older head as stale", () => {
    render(<DraftCard draft={draft("old", line(5), OLD)} stale onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText(/Written against/).textContent).toMatch(/^Written against 0000000;/);
  });
});
