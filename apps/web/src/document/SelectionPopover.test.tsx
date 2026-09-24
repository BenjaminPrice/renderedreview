// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The selection popover over a rendered document: mouse and keyboard selection, Comment/Suggest, Escape.
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { SelectionPopover } from "./SelectionPopover";

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
        <article ref={setArticle}>{toJsxRuntime(rendered.tree, { Fragment, jsx, jsxs })}</article>
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
