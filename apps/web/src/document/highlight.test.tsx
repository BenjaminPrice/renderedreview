// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { renderMarkdown, selectionToSource, type SourceSelection } from "@rendered-review/markdown-domain";
import { cleanup, render } from "@testing-library/react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { usePendingHighlight } from "./highlight";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const source = "# Title\n\nHello brave new world.\n\nAnother paragraph.\n";
const rendered = renderMarkdown(source);
const paragraph = rendered.nodes.find((n) => n.type === "paragraph")!;
const result = selectionToSource(rendered, source, { id: paragraph.id, offset: 6 }, { id: paragraph.id, offset: 11 });
const selection = (result as { ok: true; selection: SourceSelection }).selection;

function Page({ selected }: { selected?: SourceSelection }) {
  const [article, setArticle] = useState<HTMLElement | null>(null);
  usePendingHighlight(article, rendered, source, selected);
  return <article ref={setArticle}>{toJsxRuntime(rendered.tree, { Fragment, jsx, jsxs })}</article>;
}

it("marks the selected blocks when the CSS Custom Highlight API is missing", () => {
  const { container, rerender } = render(<Page selected={selection} />);
  expect([...container.querySelectorAll("[data-rr-pending]")].map((el) => el.textContent)).toEqual([
    "Hello brave new world.",
  ]);
  rerender(<Page />);
  expect(container.querySelectorAll("[data-rr-pending]")).toHaveLength(0);
});

it("highlights exactly the selected text with the CSS Custom Highlight API", () => {
  const highlights = new Map<string, { ranges: Range[] }>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    },
  );
  const { container, rerender } = render(<Page selected={selection} />);
  expect(highlights.get("rr-pending")!.ranges.map((r) => r.toString())).toEqual(["brave"]);
  expect(container.querySelectorAll("[data-rr-pending]")).toHaveLength(0);
  rerender(<Page />);
  expect(highlights.has("rr-pending")).toBe(false);
});
