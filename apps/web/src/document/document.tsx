// SPDX-License-Identifier: AGPL-3.0-only
// Loads, renders and marks up one PR document. The comment rail consumes `useDocument`'s
// result and the article element (`containerRef`), and finds rendered blocks with `nodeElement`.
import { blocksForLines, renderMarkdown, type RenderedMarkdown } from "@rendered-review/markdown-domain";
import { NotFoundError } from "@rendered-review/github-integration";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { Element, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { toString } from "hast-util-to-string";
import { useContext, useMemo, type MouseEvent, type Ref } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { DiagramBlock, DiagramSourceContext, type DiagramSource } from "../diagram/DiagramBlock";
import { DiagramRegistryContext } from "../diagram/registry";
import { isMarkdownPath } from "../pr-url";
import { blobQuery, fileAtCommitQuery, type PrIdentity } from "../github/queries";
import { type ChangeKind, changedLines, type DocEntry, type LineChange, sourceUrl } from "./docs";
import type { RevisionSource } from "./revisions";

// ponytail: fixed size cap on the main thread; move parsing to a cancellable Web Worker and
// set the threshold from browser benchmarks when large documents matter.
export const MAX_RENDER_CHARS = 1_000_000;

const RENDER_CACHE_SIZE = 32;
const renderCache = new Map<string, RenderedMarkdown | Error>();

/** In-app route for a repository Markdown file; other links keep GitHub's default. */
export function inAppDocLink(id: PrIdentity, path: string, suffix: string): string | undefined {
  if (!isMarkdownPath(path)) return undefined;
  const hash = suffix.includes("#") ? suffix.slice(suffix.indexOf("#")) : "";
  return `/${id.host}/${id.owner}/${id.repo}/pull/${id.number}?${new URLSearchParams({ doc: path })}${hash}`;
}

/**
 * `renderMarkdown` memoized by blob and location, so UI state changes and revisits never
 * reparse. Relative links and images resolve at `sha`; Markdown links open in this PR.
 * `.mdx` files parse as MDX; invalid MDX yields its parse error.
 */
function renderBlob(id: PrIdentity, sha: string, entry: DocEntry, source: string): RenderedMarkdown | Error {
  const key = `${entry.oid}:${sha}:${entry.path}`;
  let rendered = renderCache.get(key);
  if (!rendered) {
    try {
      rendered = renderMarkdown(source, {
        location: { host: id.host, owner: id.owner, repo: id.repo, commitOid: sha, path: entry.path },
        resolveLink: (path, suffix) => inAppDocLink(id, path, suffix),
        format: /\.mdx$/i.test(entry.path) ? "mdx" : "md",
      });
    } catch (error) {
      rendered = error instanceof Error ? error : new Error(String(error));
    }
    if (renderCache.size >= RENDER_CACHE_SIZE) renderCache.delete(renderCache.keys().next().value!);
    renderCache.set(key, rendered);
  }
  return rendered;
}

export interface LoadedDocument {
  source?: string;
  /** Undefined while loading, when the source exceeds `MAX_RENDER_CHARS`, or on `renderError`. */
  rendered?: RenderedMarkdown;
  /** Why the source could not be rendered (invalid MDX); show it raw instead. */
  renderError?: Error;
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
  // Read by path: listing the base tree to find the blob costs megabytes on large repositories.
  const basePath = entry?.previousPath ?? entry?.path ?? "";
  const base = useQuery({ ...fileAtCommitQuery(id, id.baseSha, basePath), enabled: diffBase });

  const source = head.data;
  const sha = deleted ? id.baseSha : id.headSha;
  const tooLarge = (source?.length ?? 0) > MAX_RENDER_CHARS;
  const result = useMemo(
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
    rendered: result instanceof Error ? undefined : result,
    renderError: result instanceof Error ? result : undefined,
    tooLarge,
    changes,
    sha,
    // A missing base blob only costs the change markers; don't fail the document for it.
    error: head.error,
  };
}

export interface RevisionDocument extends LoadedDocument {
  /** Where the document was at that commit (its old path, if since renamed). */
  path: string;
  /** Identifies the content for caches: its blob OID, or commit and path when read by path. */
  key: string;
  /** The blob OID, when it was read by it. */
  blobOid?: string;
}

/** A document as it was at an earlier commit, read-only: no change markers. */
export function useRevisionDocument(
  id: PrIdentity,
  entry: DocEntry | undefined,
  revision: RevisionSource | undefined,
): RevisionDocument | undefined {
  const { commitOid = "", blobOid, path = "", fallbackPath } = revision ?? {};
  const byBlob = useQuery({ ...blobQuery(id, blobOid ?? ""), enabled: !!blobOid });
  const byPath = useQuery({ ...fileAtCommitQuery(id, commitOid, path), enabled: !!revision && !blobOid });
  const renamed = !!fallbackPath && byPath.error instanceof NotFoundError;
  const byOldPath = useQuery({ ...fileAtCommitQuery(id, commitOid, fallbackPath ?? ""), enabled: renamed });
  const read = blobOid ? byBlob : renamed ? byOldPath : byPath;
  const shownPath = renamed ? fallbackPath! : path;
  const key = blobOid ?? `${commitOid}:${shownPath}`;
  const source = read.data;
  const tooLarge = (source?.length ?? 0) > MAX_RENDER_CHARS;
  const result = useMemo(
    () =>
      entry && source !== undefined && !tooLarge
        ? renderBlob(id, commitOid, { ...entry, oid: key, path: shownPath }, source)
        : undefined,
    [id, commitOid, entry, key, shownPath, source, tooLarge],
  );
  if (!revision) return undefined;
  return {
    source,
    rendered: result instanceof Error ? undefined : result,
    renderError: result instanceof Error ? result : undefined,
    tooLarge,
    changes: NO_CHANGES,
    sha: commitOid,
    error: read.error,
    path: shownPath,
    key,
    ...(blobOid && { blobOid }),
  };
}

const NO_CHANGES: LineChange[] = [];

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
  link,
  blobOid,
  containerRef,
}: {
  rendered: RenderedMarkdown;
  changes: LineChange[];
  /** Where the document lives, for diagram source-line links. */
  link: DiagramSource["link"];
  blobOid: string;
  containerRef?: Ref<HTMLElement>;
}) {
  const registry = useContext(DiagramRegistryContext);
  const content = useMemo(
    () =>
      toJsxRuntime(withMarks(rendered.tree, changeMarks(rendered, changes)), {
        Fragment,
        jsx,
        jsxs,
        passNode: true,
        components: {
          // Fences in a registered diagram format render as diagrams; the rest stay code.
          pre: ({ node, children, ...attributes }) => {
            const fence = node && rendered.nodes[node.properties.dataRrId as number];
            const entry = fence?.type === "code" ? registry.match(fence.lang) : undefined;
            if (!node || !fence || !entry) return <pre {...attributes}>{children}</pre>;
            const code = node.children[0] as Element | undefined; // pre > code
            return (
              <DiagramBlock
                entry={entry}
                node={fence}
                codeId={code?.properties.dataRrId as number}
                source={toString(node).replace(/\n$/, "")}
                attributes={attributes}
              />
            );
          },
        },
      }),
    [rendered, changes, registry],
  );
  const onClick = useInAppLinks();
  const { host, owner, repo, sha, path } = link;
  const source = useMemo(
    () => ({ blobOid, changes, link: { host, owner, repo, sha, path } }),
    [blobOid, changes, host, owner, repo, sha, path],
  );
  return (
    <article ref={containerRef} className="rr-markdown" aria-label="Rendered document" onClick={onClick}>
      <DiagramSourceContext value={source}>{content}</DiagramSourceContext>
    </article>
  );
}

/** Click handler for rendered Markdown: links to other documents in this PR navigate in-app instead of reloading. */
export function useInAppLinks() {
  const router = useRouter();
  return (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href || href.startsWith("#") || link.origin !== window.location.origin) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void router.navigate({ href: link.pathname + link.search + link.hash });
  };
}

export function RawDocument({
  source,
  changes,
  link,
  firstLine = 1,
  target,
  label = "Markdown source",
}: {
  source: string;
  changes: LineChange[];
  link: { host: string; owner: string; repo: string; sha: string; path: string };
  /** Line number of the first line of `source` (an excerpt such as a diagram fence). */
  firstLine?: number;
  /** Lines a line link points at, marked with `data-rr-target`. */
  target?: { start: number; end: number };
  label?: string;
}) {
  const kinds = useMemo(() => {
    const byLine = new Map<number, ChangeKind>();
    for (const c of changes) for (let n = c.start; n <= c.end; n++) byLine.set(n, c.kind);
    return byLine;
  }, [changes]);
  // Lines keep their own line endings (a lone CR shows as a break), so the text is the source's.
  const lines = useMemo(() => (source === "" ? [] : source.split(/(?<=\n|\r(?!\n))/)), [source]);
  return (
    <pre className="rr-raw" aria-label={label}>
      <code>
        {lines.map((text, i) => {
          const n = firstLine + i;
          return (
            <span
              key={i}
              className="rr-raw-line"
              data-rr-change={kinds.get(n)}
              data-rr-target={target && n >= target.start && n <= target.end ? "" : undefined}
            >
              <a
                className="rr-raw-num"
                data-rr-ui=""
                href={sourceUrl(link, link.sha, link.path, n)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Line ${n} on GitHub (opens in new tab)`}
              >
                {n}
              </a>
              {/\n$/.test(text) ? text : text.replace(/\r?$/, "\n")}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
