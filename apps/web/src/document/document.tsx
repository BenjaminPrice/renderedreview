// SPDX-License-Identifier: AGPL-3.0-only
// Loads, renders and marks up one PR document. The comment rail consumes `useDocument`'s
// result and the article element (`containerRef`), and finds rendered blocks with `nodeElement`.
import { blocksForLines, type RenderedMarkdown } from "@rendered-review/markdown-domain";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { Element, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { toString } from "hast-util-to-string";
import { useContext, useEffect, useMemo, useState, type MouseEvent, type Ref } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { DiagramBlock, DiagramSourceContext, type DiagramSource } from "../diagram/DiagramBlock";
import { DiagramRegistryContext } from "../diagram/registry";
import { blobQuery, fileAtCommitQuery, type PrIdentity } from "../github/queries";
import { type ChangeKind, changedLines, type DocEntry, type LineChange, sourceUrl } from "./docs";
import { renderInWorker } from "./render-client";
import { renderJob } from "./render-job";

export { inAppDocLink } from "./render-job";

/** Larger sources show the size-limit state (with the raw source) instead of rendering. */
export const MAX_RENDER_CHARS = 1_000_000;

/**
 * Larger sources render in the render Worker. Rendering costs about 1.8 ms per KB of Markdown
 * (4 ms per KB for tables; see document.bench.ts), so above this a render would block input
 * beyond a 50 ms long task. Smaller ones render on the main thread at once, with no Worker startup.
 */
export const WORKER_THRESHOLD_CHARS = 32_000;

const RENDER_CACHE_SIZE = 32;
const renderCache = new Map<string, RenderedMarkdown | Error>();

function remember(key: string, rendered: RenderedMarkdown | Error) {
  if (renderCache.size >= RENDER_CACHE_SIZE) renderCache.delete(renderCache.keys().next().value!);
  renderCache.set(key, rendered);
}

const renderKey = (sha: string, entry: DocEntry) => `${entry.oid}:${sha}:${entry.path}`;

/**
 * `renderMarkdown` memoized by blob and location, so UI state changes and revisits never
 * reparse. Relative links and images resolve at `sha`; Markdown links open in this PR.
 * `.mdx` files parse as MDX; invalid MDX yields its parse error.
 */
function renderBlob(id: PrIdentity, sha: string, entry: DocEntry, source: string): RenderedMarkdown | Error {
  const key = renderKey(sha, entry);
  let rendered = renderCache.get(key);
  if (!rendered) {
    try {
      rendered = renderJob({ source, pr: id, sha, path: entry.path });
    } catch (error) {
      rendered = error instanceof Error ? error : new Error(String(error));
    }
    remember(key, rendered);
  }
  return rendered;
}

/**
 * `source` rendered: at once on the main thread up to `WORKER_THRESHOLD_CHARS`, else in the render
 * Worker, `rendering` meanwhile. A new document or revision cancels the render in flight. Results
 * are cached per blob either way.
 */
export function useRendered(
  id: PrIdentity,
  sha: string,
  entry: DocEntry | undefined,
  source: string | undefined,
): { result?: RenderedMarkdown | Error; rendering: boolean } {
  const key = entry && source !== undefined ? renderKey(sha, entry) : undefined;
  const offload = (source?.length ?? 0) > WORKER_THRESHOLD_CHARS;
  const onMain = useMemo(
    () => (entry && source !== undefined && !offload ? renderBlob(id, sha, entry, source) : undefined),
    [id, sha, entry, source, offload],
  );
  const [, rendered] = useState(0);
  const { host, owner, repo, number } = id;
  const path = entry?.path;
  useEffect(() => {
    if (!key || !offload || path === undefined || source === undefined || renderCache.has(key)) return;
    const controller = new AbortController();
    const pr = { host, owner, repo, number };
    const done = () => controller.signal.aborted || rendered((n) => n + 1);
    renderInWorker({ source, pr, sha, path }, controller.signal).then(
      (result) => {
        remember(key, result);
        done();
      },
      () => {
        if (controller.signal.aborted) return;
        // Worker unavailable: render here rather than not at all.
        renderBlob(pr as PrIdentity, sha, entry!, source);
        done();
      },
    );
    return () => controller.abort();
  }, [key, offload, source, sha, path, host, owner, repo, number]);
  const result = offload ? key && renderCache.get(key) : onMain;
  return { result: result || undefined, rendering: offload && !!key && !result };
}

export interface LoadedDocument {
  source?: string;
  /** Undefined while loading, when the source exceeds `MAX_RENDER_CHARS`, or on `renderError`. */
  rendered?: RenderedMarkdown;
  /** Why the source could not be rendered (invalid MDX); show it raw instead. */
  renderError?: Error;
  tooLarge: boolean;
  /** A large document is rendering in the render Worker. */
  rendering: boolean;
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
  const { result, rendering } = useRendered(id, sha, entry, tooLarge ? undefined : source);
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
    rendering,
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
