// SPDX-License-Identifier: AGPL-3.0-only
// Comment bodies as sanitized GitHub Flavored Markdown, rendered to React elements (never HTML strings).
import { renderMarkdown, type ResourceOptions } from "@rendered-review/markdown-domain";
import type { Element, Nodes } from "hast";
import { toString } from "hast-util-to-string";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { ExternalLink } from "../ui/ExternalLink";

export interface Suggestion {
  /** Lines the suggestion replaces, when known. */
  original: string[] | null;
  /** Where GitHub offers to apply it. */
  href: string;
}

// Comment bodies must not carry the document's source-map markers, or anchor lookups by
// `data-rr-id` would find elements inside comments.
function strip(node: Nodes) {
  if (node.type === "element") {
    delete node.properties.dataRrId;
    delete node.properties.dataRrUnmapped;
  }
  if ("children" in node) node.children.forEach(strip);
}

const isSuggestion = (pre?: Element) => {
  const code = pre?.children[0];
  return code?.type === "element" && String(code.properties.className ?? "").includes("language-suggestion");
};

export function Markdown({
  source,
  suggestion,
  options,
  className = "rr-md",
}: {
  source: string;
  suggestion?: Suggestion;
  /** Where relative links and images resolve (memoize it); without it they are dropped. */
  options?: ResourceOptions;
  className?: string;
}) {
  const original = suggestion?.original?.join("\n");
  const href = suggestion?.href;
  const content = useMemo(() => {
    const { tree } = renderMarkdown(source, options);
    strip(tree);
    return toJsxRuntime(tree, {
      Fragment,
      jsx,
      jsxs,
      passNode: true,
      components: {
        pre: ({ node, children, ...props }) =>
          href && isSuggestion(node) ? (
            <ProposedChange
              original={original === undefined ? null : original.split("\n")}
              proposed={toString(node!).replace(/\n$/, "")}
              href={href}
            />
          ) : (
            <pre {...props}>{children}</pre>
          ),
        table: ({ children }) => <CommentTable>{children}</CommentTable>,
      },
    });
  }, [source, original, href, options]);
  return <div className={className}>{content}</div>;
}

function ProposedChange({ original, proposed, href }: { original: string[] | null; proposed: string; href: string }) {
  return (
    <ChangeDiff
      label="Suggested change"
      aside={<ExternalLink href={href}>Apply on GitHub</ExternalLink>}
      original={original ?? []}
      proposed={proposed.split("\n")}
    />
  );
}

/** Removed then added lines, in the change styles; text only, never HTML. */
export function ChangeDiff({
  label,
  aside,
  original,
  proposed,
}: {
  label: string;
  aside?: ReactNode;
  original: string[];
  proposed: string[];
}) {
  const row = (kind: "del" | "add", text: string, key: number): ReactNode => (
    <div key={`${kind}${key}`} className={`rr-diff-${kind}`}>
      <span className="rr-sr-only">{kind === "del" ? "Removed: " : "Added: "}</span>
      {text || " "}
    </div>
  );
  return (
    <div className="rr-diff" role="group" aria-label={label}>
      <div className="rr-diff-head">
        <span>{label}</span>
        {aside}
      </div>
      {original.map((l, i) => row("del", l, i))}
      {proposed.map((l, i) => row("add", l, i))}
    </div>
  );
}

/**
 * A comment table scrolls sideways in the narrow rail, and opens in a modal for easier reading.
 * The modal shows the same rendered (sanitized) table elements.
 */
function CommentTable({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const expand = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    close.current?.focus();
  }, [open]);
  const scroller = (
    <div className="rr-table-scroll" role="region" aria-label="Scrollable table" tabIndex={0}>
      <table>{children}</table>
    </div>
  );
  return (
    <div className="rr-md-table">
      {scroller}
      <button ref={expand} type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={() => setOpen(true)}>
        Expand table
      </button>
      {/* Escape and the Close button both end in `close`; the modal makes the page behind it inert. */}
      <dialog
        ref={dialog}
        className="rr-table-dialog"
        aria-label="Table"
        // The browser handles Escape here; page shortcuts (closing the slide-over) must not also run.
        onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
        onClose={() => {
          setOpen(false);
          expand.current?.focus();
        }}
      >
        {open && (
          <>
            <div className="rr-table-dialog-head">
              <span>Table</span>
              <button ref={close} type="button" className="rr-btn rr-btn-sm" onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
            {scroller}
          </>
        )}
      </dialog>
    </div>
  );
}
