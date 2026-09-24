// SPDX-License-Identifier: AGPL-3.0-only
// Comment bodies as sanitized GitHub Flavored Markdown, rendered to React elements (never HTML strings).
import { renderMarkdown } from "@rendered-review/markdown-domain";
import type { Element, Nodes } from "hast";
import { toString } from "hast-util-to-string";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useMemo, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

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

export function Markdown({ source, suggestion }: { source: string; suggestion?: Suggestion }) {
  const original = suggestion?.original?.join("\n");
  const href = suggestion?.href;
  const content = useMemo(() => {
    const { tree } = renderMarkdown(source);
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
      },
    });
  }, [source, original, href]);
  return <div className="rr-md">{content}</div>;
}

function ProposedChange({ original, proposed, href }: { original: string[] | null; proposed: string; href: string }) {
  const row = (kind: "del" | "add", text: string, key: number): ReactNode => (
    <div key={`${kind}${key}`} className={`rr-diff-${kind}`}>
      <span className="rr-sr-only">{kind === "del" ? "Removed: " : "Added: "}</span>
      {text || " "}
    </div>
  );
  return (
    <div className="rr-diff" role="group" aria-label="Suggested change">
      <div className="rr-diff-head">
        <span>Suggested change</span>
        <a href={href} target="_blank" rel="noreferrer">
          Apply on GitHub
        </a>
      </div>
      {original?.map((l, i) => row("del", l, i))}
      {proposed.split("\n").map((l, i) => row("add", l, i))}
    </div>
  );
}
