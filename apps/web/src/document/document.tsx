// SPDX-License-Identifier: AGPL-3.0-only
// Loads, renders and marks up one PR document. The comment rail consumes `useDocument`'s
// result and the article element (`containerRef`), and finds rendered blocks with `nodeElement`.
import { blocksForLines, renderMarkdown, type RenderedMarkdown } from "@rendered-review/markdown-domain";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { Element, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useMemo, type Ref } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { isMarkdownPath } from "../pr-url";
import { blobQuery, type PrIdentity, treeQuery } from "../github/queries";
import { type ChangeKind, changedLines, type DocEntry, type LineChange, sourceUrl, splitLines } from "./docs";

// ponytail: fixed size cap on the main thread; move parsing to a cancellable Web Worker and
// set the threshold from browser benchmarks when large documents matter.
export const MAX_RENDER_CHARS = 1_000_000;

const RENDER_CACHE_SIZE = 32;
const renderCache = new Map<string, RenderedMarkdown>();

/** In-app route for a repository Markdown file; other links keep GitHub's default. */
export function inAppDocLink(id: PrIdentity, path: string, suffix: string): string | undefined {
  if (!isMarkdownPath(path)) return undefined;
  const hash = suffix.includes("#") ? suffix.slice(suffix.indexOf("#")) : "";
  return `/${id.host}/${id.owner}/${id.repo}/pull/${id.number}?${new URLSearchParams({ doc: path })}${hash}`;
}

/**
 * `renderMarkdown` memoized by blob and location, so UI state changes and revisits never
 * reparse. Relative links and images resolve at `sha`; Markdown links open in this PR.
 */
function renderBlob(id: PrIdentity, sha: string, entry: DocEntry, source: string): RenderedMarkdown {
  const key = `${entry.oid}:${sha}:${entry.path}`;
  let rendered = renderCache.get(key);
  if (!rendered) {
    rendered = renderMarkdown(source, {
      location: { host: id.host, owner: id.owner, repo: id.repo, commitOid: sha, path: entry.path },
      resolveLink: (path, suffix) => inAppDocLink(id, path, suffix),
    });
    if (renderCache.size >= RENDER_CACHE_SIZE) renderCache.delete(renderCache.keys().next().value!);
    renderCache.set(key, rendered);
  }
  return rendered;
}

export interface LoadedDocument {
  source?: string;
  /** Undefined while loading, or when the source exceeds `MAX_RENDER_CHARS`. */
  rendered?: RenderedMarkdown;
  tooLarge: boolean;
  /** Head lines changed by the PR; empty for unchanged and deleted documents. */
  changes: LineChange[];
  /** The commit the shown blob belongs to: base for deleted documents, else head. */
  sha: string;
  error: Error | null;
}

export function useDocument(id: PrIdentity, entry: DocEntry | undefined): LoadedDocument {
  const deleted = entry?.status === "deleted";
  const diffBase = entry?.status === "modified" || entry?.status === "renamed";
  const head = useQuery({ ...blobQuery(id, entry?.oid ?? ""), enabled: !!entry });
  const baseTree = useQuery({ ...treeQuery(id, id.baseSha), enabled: diffBase });
  const basePath = entry?.previousPath ?? entry?.path;
  const baseOid = diffBase ? baseTree.data?.entries.find((e) => e.path === basePath)?.oid : undefined;
  const base = useQuery({ ...blobQuery(id, baseOid ?? ""), enabled: !!baseOid });

  const source = head.data;
  const sha = deleted ? id.baseSha : id.headSha;
  const tooLarge = (source?.length ?? 0) > MAX_RENDER_CHARS;
  const rendered = useMemo(
    () => (entry && source !== undefined && !tooLarge ? renderBlob(id, sha, entry, source) : undefined),
    [id, sha, entry, source, tooLarge],
  );
  const baseSource = entry?.status === "added" ? "" : base.data;
  const changes = useMemo(
    () => (source !== undefined && baseSource !== undefined ? changedLines(baseSource, source) : []),
    [source, baseSource],
  );
  return {
    source,
    rendered,
    tooLarge,
    changes,
    sha,
    // A missing base blob only costs the change markers; don't fail the document for it.
    error: head.error,
  };
}

/** The rendered element for a source node, if it is on screen in `container`. */
export const nodeElement = (container: HTMLElement, id: number): HTMLElement | null =>
  container.querySelector(`[data-rr-id="${id}"]`);

/** Innermost blocks touched by each change; `modified` wins where both touch a block. */
export function changeMarks(rendered: RenderedMarkdown, changes: LineChange[]): Map<number, ChangeKind> {
  const marks = new Map<number, ChangeKind>();
  for (const change of changes) {
    for (const node of blocksForLines(rendered, change.start, change.end)) {
      if (marks.get(node.id) !== "modified") marks.set(node.id, change.kind);
    }
  }
  return marks;
}

/** A copy of `tree` with `data-rr-change` on marked elements. Markers are attributes, not text, so DOM text stays source-true. */
function withMarks(tree: Root, marks: Map<number, ChangeKind>): Root {
  if (marks.size === 0) return tree;
  const copy = structuredClone(tree);
  const walk = (parent: Root | Element) => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      const kind = marks.get(child.properties.dataRrId as number);
      if (kind) child.properties.dataRrChange = kind;
      walk(child);
    }
  };
  walk(copy);
  return copy;
}

export function RenderedDocument({
  rendered,
  changes,
  containerRef,
}: {
  rendered: RenderedMarkdown;
  changes: LineChange[];
  containerRef?: Ref<HTMLElement>;
}) {
  const content = useMemo(
    () => toJsxRuntime(withMarks(rendered.tree, changeMarks(rendered, changes)), { Fragment, jsx, jsxs }),
    [rendered, changes],
  );
  const router = useRouter();
  return (
    <article
      ref={containerRef}
      className="rr-markdown"
      aria-label="Rendered document"
      onClick={(event) => {
        // Links to other documents in this PR navigate in-app instead of reloading the page.
        const link = (event.target as HTMLElement).closest("a");
        const href = link?.getAttribute("href");
        if (!link || !href || href.startsWith("#") || link.origin !== window.location.origin) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void router.navigate({ href: link.pathname + link.search + link.hash });
      }}
    >
      {content}
    </article>
  );
}

export function RawDocument({
  source,
  changes,
  link,
}: {
  source: string;
  changes: LineChange[];
  link: { host: string; owner: string; repo: string; sha: string; path: string };
}) {
  const kinds = useMemo(() => {
    const byLine = new Map<number, ChangeKind>();
    for (const c of changes) for (let n = c.start; n <= c.end; n++) byLine.set(n, c.kind);
    return byLine;
  }, [changes]);
  const lines = useMemo(() => splitLines(source), [source]);
  return (
    <pre className="rr-raw" aria-label="Markdown source">
      <code>
        {lines.map((text, i) => (
          <span key={i} className="rr-raw-line" data-rr-change={kinds.get(i + 1)}>
            <a
              className="rr-raw-num"
              href={sourceUrl(link, link.sha, link.path, i + 1)}
              aria-label={`Line ${i + 1} on GitHub`}
            >
              {i + 1}
            </a>
            {text + "\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}
/** Outbound-link icon. */
export function ExternalIcon() {
  return (
    <svg className="rr-icon rr-icon-sm" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />
    </svg>
  );
}
