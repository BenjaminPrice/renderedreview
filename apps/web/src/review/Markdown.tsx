// SPDX-License-Identifier: AGPL-3.0-only
// Comment bodies as sanitized GitHub Flavored Markdown, rendered to React elements (never HTML strings).
import { extractAnnotation } from "@rendered-review/annotation-domain";
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

const isCode = (language: string, pre?: Element) => {
  const code = pre?.children[0];
  return code?.type === "element" && String(code.properties.className ?? "").includes(`language-${language}`);
};

// The manual-apply line of a Rendered Review proposed change, as rendered text.
const MANUAL_APPLY =
  "Suggested change (apply it manually; GitHub cannot apply suggestions outside the pull request diff):";

/**
 * "L22–24" when `source` carries a Rendered Review suggestion annotation, which makes its `diff`
 * block a proposed change; otherwise undefined.
 */
function proposedChangeLines(source: string): string | undefined {
  const found = extractAnnotation(source);
  if (found.status !== "ok" || found.annotation.motivation !== "suggesting") return undefined;
  const range = found.annotation.target.selectors.find((s) => s.type === "MarkdownSourceRangeSelector");
  if (!range) return "";
  // Half-open: ending at column 1 means the previous line was the last one.
  const end = range.endColumn === 1 && range.endLine > range.startLine ? range.endLine - 1 : range.endLine;
  return end === range.startLine ? `L${end}` : `L${range.startLine}–${end}`;
}

/** Removed and added lines of a proposed change's `diff` block; null if any line is neither. */
function parseChange(text: string): { original: string[]; proposed: string[] } | null {
  const lines = text.replace(/\n$/, "").split("\n");
  if (!lines.every((l) => l.startsWith("-") || l.startsWith("+"))) return null;
  const side = (sign: string) => lines.filter((l) => l.startsWith(sign)).map((l) => l.slice(1));
  return { original: side("-"), proposed: side("+") };
}

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
    const changeLines = proposedChangeLines(source);
    const change = (pre?: Element) =>
      changeLines !== undefined && isCode("diff", pre) ? parseChange(toString(pre!)) : null;
    const { tree } = renderMarkdown(source, options);
    strip(tree);
    const hasChange = (n: Nodes): boolean =>
      (n.type === "element" && n.tagName === "pre" && change(n) !== null) ||
      ("children" in n && n.children.some(hasChange));
    // The manual-apply line goes when the proposed change it introduces is shown with its own note.
    const dropManualApply = hasChange(tree);
    return toJsxRuntime(tree, {
      Fragment,
      jsx,
      jsxs,
      passNode: true,
      components: {
        pre: ({ node, children, ...props }) => {
          if (href && isCode("suggestion", node))
            return (
              <ProposedChange
                original={original === undefined ? null : original.split("\n")}
                proposed={toString(node!).replace(/\n$/, "")}
                href={href}
              />
            );
          const proposed = change(node);
          if (proposed)
            // Never an Apply action: GitHub cannot apply it, and the app makes no commits.
            return (
              <>
                <ChangeDiff label="Proposed change" aside={<span>{changeLines}</span>} {...proposed} />
                <p className="rr-notice">
                  <span>
                    Outside this PR's diff, so GitHub can't apply it. <b>Apply manually.</b>
                  </span>
                </p>
              </>
            );
          // Focusable, so keyboard readers can scroll wide code sideways.
          return (
            <pre {...props} tabIndex={0}>
              {children}
            </pre>
          );
        },
        p: ({ node, children, ...props }) =>
          dropManualApply && toString(node!) === MANUAL_APPLY ? null : <p {...props}>{children}</p>,
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

/** A change's lines; an empty text is no lines (a deletion). */
export const diffLines = (text: string) => (text === "" ? [] : text.split("\n"));

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
