// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { repairCommentBody } from "@rendered-review/annotation-domain";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { annotation, issueComment } from "./fixtures";
import { RepairPreview } from "./RepairPreview";

afterEach(cleanup);

const selection: SourceSelection = {
  exact: "backs off",
  prefix: "It ",
  suffix: " quickly.",
  textPosition: { start: 40, end: 49 },
  sourceRange: { startLine: 5, startColumn: 4, endLine: 5, endColumn: 13 },
  nodeType: "paragraph",
  headingPath: [],
  blockIds: [3],
  expanded: false,
};
const moved = annotation();
moved.target.selectors = [
  { type: "TextQuoteSelector", exact: "backs off" },
  { type: "TextPositionSelector", start: 40, end: 49 },
  { type: "MarkdownSourceRangeSelector", startLine: 5, startColumn: 4, endLine: 5, endColumn: 13 },
];
const TEXT = "Needs a *retry* limit.  \r\n\r\n- and backoff";
const old = issueComment(TEXT);
const repaired = repairCommentBody({ body: old.body, annotation: moved, location: "conversation" });

function mount(props: Partial<Parameters<typeof RepairPreview>[0]> = {}) {
  const onConfirm = vi.fn(async () => {});
  const onCancel = vi.fn();
  render(
    <RepairPreview selection={selection} repaired={repaired} onConfirm={onConfirm} onCancel={onCancel} {...props} />,
  );
  return { onConfirm, onCancel, region: screen.getByRole("region", { name: "Repair anchor" }) };
}

it("previews the GitHub body change: new quote and link, the comment text exactly as it is", () => {
  const { region } = mount();
  const quote = within(region).getByRole("group", { name: "Quote" });
  expect(within(quote).getByText("> retries failed requests").className).toBe("rr-diff-del");
  expect(within(quote).getByText("> backs off").className).toBe("rr-diff-add");
  const link = within(region).getByRole("group", { name: "Document link" });
  expect(link.querySelector(".rr-diff-del")!.textContent).toContain("#L3-L3");
  expect(link.querySelector(".rr-diff-add")!.textContent).toContain("#L5-L5");
  // Shown raw, byte for byte, not rendered: this is the text that stays on GitHub.
  expect(within(region).getByRole("group", { name: "Your comment, unchanged" }).textContent).toBe(TEXT);
  expect(repaired.body).toContain(TEXT);
  expect(region.textContent).toMatch(/hidden metadata/i);
});

it("changes nothing until Update comment is chosen", async () => {
  const { onConfirm, region } = mount();
  expect(onConfirm).not.toHaveBeenCalled();
  await userEvent.click(within(region).getByRole("button", { name: "Update comment" }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

it("cancels with the button or Escape, without updating", async () => {
  const { onConfirm, onCancel, region } = mount();
  await userEvent.click(within(region).getByRole("button", { name: "Cancel" }));
  within(region).getByRole("button", { name: "Update comment" }).focus();
  await userEvent.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("takes focus, so keyboard users land on the preview", () => {
  const { region } = mount();
  expect(region.contains(document.activeElement)).toBe(true);
});

it("explains why a selection can't be used, and offers no update", () => {
  const { region } = mount({ repaired: undefined, error: "Select text on L2–L3." });
  expect(within(region).getByText("Select text on L2–L3.")).toBeTruthy();
  expect(within(region).getByRole("button", { name: "Update comment" })).toHaveProperty("disabled", true);
});

it("shows a refused update and keeps the preview", async () => {
  const onConfirm = vi.fn(async () => {
    throw new Error("Only the comment's author can repair its anchor");
  });
  const { region } = mount({ onConfirm });
  await userEvent.click(within(region).getByRole("button", { name: "Update comment" }));
  expect((await within(region).findByRole("alert")).textContent).toBe(
    "Only the comment's author can repair its anchor",
  );
  expect(within(region).getByRole("button", { name: "Update comment" })).toBeTruthy();
});
