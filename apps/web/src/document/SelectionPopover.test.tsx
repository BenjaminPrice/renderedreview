// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The selection popover over a rendered document: mouse and keyboard selection, Comment/Suggest, Escape.
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { stubSelectionModify } from "../test-utils";
import { SelectionPopover } from "./SelectionPopover";

beforeAll(stubSelectionModify);

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

function mount(source: string) {
  const rendered = renderMarkdown(source);
  const onCompose = vi.fn();
  function Page() {
    const [article, setArticle] = useState<HTMLElement | null>(null);
    return (
      <>
        <article ref={setArticle} tabIndex={0}>
          {toJsxRuntime(rendered.tree, { Fragment, jsx, jsxs })}
        </article>
        <SelectionPopover article={article} rendered={rendered} source={source} onCompose={onCompose} />
      </>
    );
  }
  render(<Page />);
  return { article: document.querySelector("article")!, onCompose };
}

/** Select from the start of `from` to the end of `to`, each within one text node. */
function selectText(article: HTMLElement, from: string, to = from) {
  const texts = [...article.querySelectorAll("*")].flatMap((el) =>
    [...el.childNodes].filter((n): n is Text => n.nodeType === Node.TEXT_NODE),
  );
  const a = texts.find((t) => t.data.includes(from))!;
  const b = texts.find((t) => t.data.includes(to) && (t !== a || t.data.indexOf(to) >= t.data.indexOf(from)))!;
  document.getSelection()!.setBaseAndExtent(a, a.data.indexOf(from), b, b.data.indexOf(to) + to.length);
}

const toolbar = () => screen.queryByRole("toolbar", { name: "Selection actions" });

it("appears after a mouse selection; Comment composes the converted selection", async () => {
  const { article, onCompose } = mount("# Title\n\nHello brave new world.\n");
  expect(toolbar()).toBeNull();
  selectText(article, "brave");
  fireEvent.mouseUp(article);
  const comment = within(toolbar()!).getByRole("button", { name: /Comment/ });
  expect(comment.getAttribute("aria-keyshortcuts")).toBe("C");
  await userEvent.click(comment);
  expect(onCompose).toHaveBeenCalledWith(
    expect.objectContaining({
      exact: "brave",
      sourceRange: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 12 },
    }),
  );
  expect(toolbar()).toBeNull();
});

it("appears after a keyboard selection; C composes and Escape dismisses", async () => {
  const { article, onCompose } = mount("Hello brave new world.\n");
  selectText(article, "brave");
  fireEvent.keyUp(article, { key: "ArrowRight", shiftKey: true });
  expect(toolbar()).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(toolbar()).toBeNull();

  selectText(article, "brave");
  fireEvent.keyUp(article, { key: "ArrowRight", shiftKey: true });
  // Copying keeps working: modified keys are not shortcuts.
  await userEvent.keyboard("{Meta>}c{/Meta}");
  expect(onCompose).not.toHaveBeenCalled();
  await userEvent.keyboard("c");
  expect(onCompose).toHaveBeenCalledWith(expect.objectContaining({ exact: "brave" }));
});

it("Suggest composes a suggestion, by button or S", async () => {
  const { article, onCompose } = mount("Hello brave new world.\n");
  selectText(article, "brave");
  fireEvent.mouseUp(article);
  const suggest = within(toolbar()!).getByRole("button", { name: /Suggest/ });
  expect(suggest.getAttribute("aria-keyshortcuts")).toBe("S");
  await userEvent.click(suggest);
  expect(onCompose).toHaveBeenLastCalledWith(expect.objectContaining({ exact: "brave" }), true);
  expect(toolbar()).toBeNull();

  fireEvent.mouseUp(article);
  await userEvent.keyboard("s");
  expect(onCompose).toHaveBeenCalledTimes(2);
  expect(onCompose).toHaveBeenLastCalledWith(expect.objectContaining({ exact: "brave" }), true);
});

it("previews the whole blocks a cross-block selection widens to", () => {
  const { article } = mount("First para.\n\nSecond para.\n");
  selectText(article, "para.", "Second");
  fireEvent.mouseUp(article);
  const preview = screen.getByText(/Comment covers lines 1–3/);
  expect(preview.textContent).toContain("First para.");
  expect(preview.textContent).toContain("Second para.");
  expect(toolbar()!.getAttribute("aria-describedby")).toBe(preview.id);
});

it("explains a selection that cannot be commented on, without actions", () => {
  const { article } = mount("---\ntitle: Hello\n---\n\nBody\n");
  selectText(article, "Hello", "Body");
  fireEvent.mouseUp(article);
  expect(screen.getByRole("status").textContent).toMatch(/front matter/);
  expect(screen.queryByRole("button", { name: /Comment/ })).toBeNull();
});

it("stays hidden for collapsed selections", () => {
  const { article } = mount("Hello brave new world.\n");
  const text = article.querySelector("p")!.firstChild!;
  document.getSelection()!.setBaseAndExtent(text, 3, text, 3);
  fireEvent.mouseUp(article);
  expect(toolbar()).toBeNull();
});

it("starts a selection at the focused element with Shift+arrows, and extends it", async () => {
  const { article, onCompose } = mount("Hello [brave](https://example.com) new world.\n");
  article.querySelector("a")!.focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowLeft}{/Shift}");
  expect(document.getSelection()!.toString()).toBe("bra");
  expect(toolbar()).toBeTruthy();
  await userEvent.keyboard("c");
  expect(onCompose).toHaveBeenCalledWith(expect.objectContaining({ exact: "bra" }));
});

it("starts at the first block in view when the document itself has focus", async () => {
  const { article } = mount("First para.\n\nSecond para.\n");
  // The first paragraph is scrolled out of view above.
  vi.spyOn(article.querySelector("p")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -40, 100, 20));
  article.focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
  expect(document.getSelection()!.toString()).toBe("Se");
});

it("leaves Shift+arrows alone in form fields", async () => {
  mount("Hello brave new world.\n");
  const input = document.createElement("input");
  document.querySelector("article")!.append(input);
  input.focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
  expect(document.getSelection()!.toString()).toBe("");
});

it("Escape collapses the selection to where it ends, so Shift+arrows can start a new one there", async () => {
  const { article, onCompose } = mount("Hello brave new world.\n");
  article.focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}");
  expect(document.getSelection()!.toString()).toBe("Hello ");
  await userEvent.keyboard("{Escape}");
  expect(toolbar()).toBeNull();
  await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}");
  expect(document.getSelection()!.toString()).toBe("brave");
  await userEvent.keyboard("c");
  expect(onCompose).toHaveBeenCalledWith(expect.objectContaining({ exact: "brave" }));
});

it("starts after the front matter, which cannot be commented on", async () => {
  const { article } = mount("---\ntitle: Hello\n---\n\nBody text.\n");
  article.focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
  expect(document.getSelection()!.toString()).toBe("Bo");
});
