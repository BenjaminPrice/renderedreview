// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import type { Representation } from "@rendered-review/review-domain";
import { composeDraftBody, prepareAnnotation } from "./compose";
import { Markdown } from "./Markdown";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The shape of a deploy-preview bot comment: a wide table in a narrow rail.
const TABLE = [
  "| Status | Deployment URL | Commit | Updated (UTC) | Details |",
  "| --- | --- | --- | --- | --- |",
  "| Success | https://preview.example.dev | d4abcf8 | 2026-09-24T07:11:31Z | [Visit](https://dash.example) |",
].join("\n");

it("lets keyboard readers scroll wide code blocks", () => {
  render(<Markdown source={"```\nconst veryLongLine = 1;\n```\n"} />);
  expect(screen.getByText("const veryLongLine = 1;").closest("pre")!.tabIndex).toBe(0);
});

describe("comment tables", () => {
  it("scroll horizontally in a keyboard-focusable, labelled region", () => {
    render(<Markdown source={TABLE} />);
    const region = screen.getByRole("region", { name: "Scrollable table" });
    expect(region.tabIndex).toBe(0);
    expect(within(region).getByRole("table")).toBeTruthy();
    expect(within(region).getByRole("columnheader", { name: "Deployment URL" })).toBeTruthy();
  });

  it("expand into a modal dialog showing the same table, and close back to the button", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    render(<Markdown source={TABLE} />);
    const expand = screen.getByRole("button", { name: "Expand table" });
    await userEvent.click(expand);

    expect(showModal).toHaveBeenCalledOnce();
    const dialog = screen.getByRole("dialog", { name: "Table" });
    expect(within(dialog).getByRole("columnheader", { name: "Updated (UTC)" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /Visit/ }).getAttribute("href")).toBe("https://dash.example");
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);

    await userEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
  });

  it("return focus to the button when the dialog closes another way (Escape)", async () => {
    render(<Markdown source={TABLE} />);
    const expand = screen.getByRole("button", { name: "Expand table" });
    await userEvent.click(expand);
    // The browser closes a modal dialog on Escape; happy-dom does not, so close it as the browser would.
    (screen.getByRole("dialog") as HTMLDialogElement).close();
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(expand);
  });

  it("keep Escape inside the dialog from also closing the page's slide-over rail", async () => {
    const pageEscape = vi.fn();
    document.addEventListener("keydown", pageEscape);
    render(<Markdown source={TABLE} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand table" }));
    await userEvent.keyboard("{Escape}");
    document.removeEventListener("keydown", pageEscape);
    expect(pageEscape).not.toHaveBeenCalled();
  });

  it("each table in a comment has its own expand button", () => {
    render(<Markdown source={`${TABLE}\n\ntext\n\n${TABLE}`} />);
    expect(screen.getAllByRole("button", { name: "Expand table" })).toHaveLength(2);
  });
});

describe("suggestions from Rendered Review", () => {
  const selection = {
    exact: "full jitter",
    prefix: "",
    suffix: "",
    textPosition: { start: 0, end: 11 },
    sourceRange: { startLine: 22, startColumn: 1, endLine: 25, endColumn: 1 },
    nodeType: "paragraph",
    headingPath: [],
    blockIds: [1],
    expanded: false,
  } satisfies SourceSelection;
  const prepared = prepareAnnotation(
    {
      host: "github.com",
      repositoryId: 1,
      repository: "acme/docs",
      pullRequest: 2,
      path: "retry.md",
      commitOid: "a".repeat(40),
      blobOid: "b".repeat(40),
    },
    selection,
  );
  if (!prepared.ok) throw new Error(prepared.message);
  const body = (representation: Representation, replacement = "Use ```equal``` jitter.") =>
    composeDraftBody(prepared.annotation, "Equal, not full.", representation, {
      original: "Use full jitter.\nUp to 20%.",
      replacement,
    });
  const rows = (group: HTMLElement) =>
    [...group.querySelectorAll(".rr-diff-del, .rr-diff-add")].map((row) => row.textContent);

  it("shows a proposed change to apply manually, with no way to apply it", () => {
    render(
      <Markdown
        source={body({ kind: "review-file", reason: "" })}
        suggestion={{ original: null, href: "https://github.com/x" }}
      />,
    );
    const change = screen.getByRole("group", { name: "Proposed change" });
    expect(rows(change)).toEqual([
      "Removed: Use full jitter.",
      "Removed: Up to 20%.",
      "Added: Use ```equal``` jitter.",
    ]);
    expect(within(change).getByText("L22–24")).toBeTruthy();
    expect(screen.getByText("Equal, not full.")).toBeTruthy();
    expect(screen.getByText(/Outside this PR's diff, so GitHub can't apply it\./).textContent).toBe(
      "Outside this PR's diff, so GitHub can't apply it. Apply manually.",
    );
    // The body's own manual-apply line is replaced by the note above.
    expect(screen.queryByText(/apply it manually;/)).toBeNull();
    expect(screen.queryByRole("link", { name: /apply/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
  });

  it("deletes lines when the replacement is empty", () => {
    render(<Markdown source={body({ kind: "conversation", reason: "" }, "")} />);
    expect(rows(screen.getByRole("group", { name: "Proposed change" }))).toEqual([
      "Removed: Use full jitter.",
      "Removed: Up to 20%.",
    ]);
  });

  it("keeps the Apply on GitHub link for a native suggestion", () => {
    const native = body({ kind: "review-line", line: 24, side: "RIGHT", reason: "" });
    render(<Markdown source={native} suggestion={{ original: ["old"], href: "https://github.com/x#c1" }} />);
    const change = screen.getByRole("group", { name: "Suggested change" });
    expect(
      within(change)
        .getByRole("link", { name: /Apply on GitHub/ })
        .getAttribute("href"),
    ).toBe("https://github.com/x#c1");
    expect(screen.queryByRole("group", { name: "Proposed change" })).toBeNull();
  });

  it("leaves diff blocks alone in other comments, and ones it cannot read as a change", () => {
    render(<Markdown source={"```diff\n-a\n+b\n```"} />);
    expect(screen.queryByRole("group", { name: "Proposed change" })).toBeNull();
    cleanup();
    const edited = body({ kind: "review-file", reason: "" }).replace("-Up to 20%.", " context line");
    render(<Markdown source={edited} />);
    expect(screen.queryByRole("group", { name: "Proposed change" })).toBeNull();
    expect(screen.getByText(/context line/).closest("pre")).toBeTruthy();
    expect(screen.getByText(/apply it manually;/)).toBeTruthy();
  });
});
