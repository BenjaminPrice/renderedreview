// SPDX-License-Identifier: AGPL-3.0-only
// A diagram fence in the rendered document: the renderer's sanitized SVG shown as an image, with
// zoom, a larger view, and the fence source (the authoritative, accessible alternative). The block
// is the fence's source node, so comments and change markers attach to the whole diagram.
import {
  diagramCacheKey,
  renderDiagram,
  type DiagramRendererEntry,
  type DiagramTheme,
} from "@rendered-review/diagram-domain";
import type { SourceNode } from "@rendered-review/markdown-domain";
import { useLocation } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LineChange } from "../document/docs";
import { RawDocument } from "../document/document";
import { Icon } from "../ui/AppShell";

/** Where the document came from: diagram cache keys and GitHub source-line links. */
export interface DiagramSource {
  blobOid: string;
  link: { host: string; owner: string; repo: string; sha: string; path: string };
  changes: LineChange[];
}

export const DiagramSourceContext = createContext<DiagramSource | null>(null);

// ponytail: in-memory only, by count; persist to IndexedDB if re-rendering on reload shows up.
const CACHE_SIZE = 64;
const cache = new Map<string, string>();

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function readTheme(): DiagramTheme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const query = matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    query.removeEventListener("change", onChange);
  };
}

/** The theme in effect: the reader's choice, else the system's. */
const useTheme = () => useSyncExternalStore(subscribeTheme, readTheme, () => "light" as const);

/** A title the author gave (`title`, `accTitle`, front matter), else the first line. */
function diagramTitle(source: string): string {
  const title = /^\s*(?:title:?|accTitle:)\s*(.+)$/m.exec(source)?.[1];
  return (title ?? source.split("\n").find((line) => line.trim()) ?? "").trim();
}

const firstLine = (message: string) => message.split("\n")[0]!.replace(/:\s*$/, "");

type Rendered = { url: string; width?: number } | { error: string } | undefined;

export function DiagramBlock({
  entry,
  node,
  codeId,
  source,
  attributes,
}: {
  entry: DiagramRendererEntry;
  /** The fence's source node; its range covers the whole fence. */
  node: SourceNode;
  /** The fence's `code` element: the source view carries its id, so selections there map to the fence content. */
  codeId: number;
  /** The fence content. */
  source: string;
  /** The fence element's attributes (`data-rr-id`, change markers). */
  attributes: Record<string, unknown>;
}) {
  const context = useContext(DiagramSourceContext)!;
  const theme = useTheme();
  const [rendered, setRendered] = useState<Rendered>();
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [copied, setCopied] = useState<"Copied" | "Copy failed" | null>(null);
  const [large, setLarge] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const expand = useRef<HTMLButtonElement>(null);

  const start = node.range.start.offset;
  const end = node.range.end.offset;
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      const renderer = await entry.load();
      const key = diagramCacheKey({ blobOid: context.blobOid, range: { start, end }, renderer, theme });
      let svg = cache.get(key);
      if (svg === undefined) {
        svg = (await renderDiagram(renderer, { source, theme, signal: controller.signal })).svg;
        if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
        cache.set(key, svg);
      }
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const width = Number(/^<svg[^>]*?\swidth="([\d.]+)"/.exec(svg)?.[1]) || undefined;
      setRendered({ url, width });
    })().catch((error: unknown) => {
      if (!controller.signal.aborted)
        setRendered({ error: firstLine(error instanceof Error ? error.message : String(error)) });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [entry, context.blobOid, start, end, source, theme]);

  // Content lines of the fence (the opening fence line comes first).
  const first = node.range.start.line + 1;
  const last = first + source.split("\n").length - 1;
  const hash = useLocation({ select: (l) => l.hash });
  const target = (() => {
    const m = /^#?L(\d+)(?:-L(\d+))?$/.exec(hash);
    if (!m) return undefined;
    const range = { start: Number(m[1]), end: Number(m[2] ?? m[1]) };
    return range.start <= last && range.end >= first ? range : undefined;
  })();
  useEffect(() => {
    if (target) setShowSource(true);
  }, [target?.start, target?.end]);

  useEffect(() => {
    if (!large) return;
    dialog.current?.showModal();
    close.current?.focus();
  }, [large]);

  const name = `${entry.label} diagram: ${diagramTitle(source)}`;
  const failed = rendered && "error" in rendered ? rendered.error : undefined;
  const image = rendered && "url" in rendered ? rendered : undefined;
  const sourceShown = showSource || !!failed;
  const zoomable = !!image && !sourceShown;
  const step = (delta: number) => setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (z ?? 1) + delta)));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <figure {...attributes} className="rr-diagram" aria-label={name}>
      {/* Only the source view is document text; selection and highlights skip `data-rr-ui`. */}
      <div className="rr-diagram-bar" data-rr-ui="">
        <span className="rr-diagram-title">
          {entry.label} ·{" "}
          {source
            .split("\n")
            .find((line) => line.trim())
            ?.trim()}
        </span>
        <button
          type="button"
          className="rr-btn rr-btn-sm rr-btn-icon rr-btn-ghost"
          aria-label="Zoom out"
          disabled={!zoomable}
          onClick={() => step(-ZOOM_STEP)}
        >
          <Icon name="minus" />
        </button>
        <span className="rr-diagram-zoom" aria-live="polite">
          {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
        </span>
        <button
          type="button"
          className="rr-btn rr-btn-sm rr-btn-icon rr-btn-ghost"
          aria-label="Zoom in"
          disabled={!zoomable}
          onClick={() => step(ZOOM_STEP)}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="rr-btn rr-btn-sm rr-btn-icon rr-btn-ghost"
          aria-label="Fit to width"
          disabled={!zoomable}
          onClick={() => setZoom(null)}
        >
          <Icon name="fit" />
        </button>
        <button
          ref={expand}
          type="button"
          className="rr-btn rr-btn-sm rr-btn-icon rr-btn-ghost"
          aria-label="Open larger view"
          disabled={!image}
          onClick={() => setLarge(true)}
        >
          <Icon name="expand" />
        </button>
        <button
          type="button"
          className="rr-btn rr-btn-sm rr-btn-ghost"
          aria-pressed={sourceShown}
          disabled={!!failed}
          onClick={() => setShowSource((on) => !on)}
        >
          <Icon name="code" />
          Source
        </button>
        <button type="button" className="rr-btn rr-btn-sm rr-btn-ghost" onClick={() => void copy()}>
          {copied ?? "Copy source"}
        </button>
      </div>
      {failed && (
        <p className="rr-diagram-error" data-rr-ui="">
          Could not render this diagram: {failed}
        </p>
      )}
      {sourceShown ? (
        <div data-rr-id={codeId}>
          <RawDocument
            source={source}
            changes={context.changes}
            link={context.link}
            firstLine={first}
            target={target}
            label={`${entry.label} source`}
          />
        </div>
      ) : (
        <div
          className="rr-diagram-body"
          role="region"
          aria-label={`${name}, scrollable`}
          aria-busy={!rendered}
          tabIndex={image ? 0 : undefined}
          data-rr-ui=""
        >
          {image ? (
            <img
              src={image.url}
              alt={name}
              data-zoomed={zoom !== null || undefined}
              style={zoom !== null && image.width ? { width: `${image.width * zoom}px` } : undefined}
            />
          ) : (
            <p className="rr-diagram-status">Rendering diagram…</p>
          )}
        </div>
      )}
      {/* Same modal pattern as expanded comment tables: Escape or Close end in `close`. */}
      <dialog
        ref={dialog}
        className="rr-table-dialog rr-diagram-dialog"
        data-rr-ui=""
        aria-label={name}
        onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
        onClose={() => {
          setLarge(false);
          expand.current?.focus();
        }}
      >
        {large && image && (
          <>
            <div className="rr-table-dialog-head">
              <span>{name}</span>
              <button ref={close} type="button" className="rr-btn rr-btn-sm" onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
            <img src={image.url} alt={name} style={image.width ? { width: `${image.width}px` } : undefined} />
          </>
        )}
      </dialog>
    </figure>
  );
}
