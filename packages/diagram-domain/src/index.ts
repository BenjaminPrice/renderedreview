// SPDX-License-Identifier: AGPL-3.0-only
// Registry for browser diagram renderers of fenced code blocks (`mermaid`, `dot`, ...).
// Renderers are imported only when a matching fence is rendered. Every render goes through
// `renderDiagram`, which enforces input, time and output limits and honours cancellation.

export type DiagramTheme = "light" | "dark";

export interface RenderedDiagram {
  /** Sanitized, self-contained SVG: no scripts, event handlers or external references. */
  svg: string;
}

export interface DiagramRenderer {
  id: string;
  fenceNames: string[];
  /** Part of the cache key: bump it when output for the same source can change. */
  version: string;
  /** Rejects with a concise, reader-facing message when the source cannot be rendered. */
  render(input: { source: string; theme: DiagramTheme; signal: AbortSignal }): Promise<RenderedDiagram>;
}

export interface DiagramRendererEntry {
  fenceNames: string[];
  /** Imports the renderer; called on first use only. */
  load: () => Promise<DiagramRenderer>;
}

export interface DiagramRegistry {
  /** The renderer entry for a fence's info-string language, if any. `load` is memoized. */
  match(lang: string | undefined): DiagramRendererEntry | undefined;
}

export function createDiagramRegistry(entries: DiagramRendererEntry[]): DiagramRegistry {
  const byFence = new Map<string, DiagramRendererEntry>();
  for (const entry of entries) {
    let loading: Promise<DiagramRenderer> | undefined;
    const memo: DiagramRendererEntry = {
      fenceNames: entry.fenceNames,
      load: () =>
        (loading ??= entry.load().catch((error: unknown) => {
          loading = undefined; // a failed chunk load (offline, new deploy) may succeed later
          throw error;
        })),
    };
    for (const name of entry.fenceNames) byFence.set(name.toLowerCase(), memo);
  }
  return { match: (lang) => (lang ? byFence.get(lang.toLowerCase()) : undefined) };
}

export interface DiagramLimits {
  maxInputChars: number;
  timeoutMs: number;
  maxOutputChars: number;
}

// ponytail: fixed limits for every renderer; make them per-renderer once formats need different budgets.
export const DEFAULT_DIAGRAM_LIMITS: DiagramLimits = {
  maxInputChars: 50_000,
  timeoutMs: 10_000,
  maxOutputChars: 5_000_000,
};

/**
 * Render with limits: oversized input is refused up front, the renderer's signal aborts on
 * timeout or when `input.signal` aborts, and a renderer that ignores its signal is abandoned
 * rather than awaited. Rejects with the renderer's error, or a limit or abort error.
 */
export async function renderDiagram(
  renderer: DiagramRenderer,
  input: { source: string; theme: DiagramTheme; signal: AbortSignal },
  limits: Partial<DiagramLimits> = {},
): Promise<RenderedDiagram> {
  const { maxInputChars, timeoutMs, maxOutputChars } = { ...DEFAULT_DIAGRAM_LIMITS, ...limits };
  if (input.source.length > maxInputChars) {
    throw new Error(
      `Diagram source is too large (${input.source.length} characters; the limit is ${maxInputChars})`,
    );
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  signal.throwIfAborted();
  const aborted = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );
  let result: RenderedDiagram;
  try {
    result = await Promise.race([renderer.render({ ...input, signal }), aborted]);
  } catch (error) {
    if (signal.aborted && (signal.reason as Error | undefined)?.name === "TimeoutError") {
      throw new Error("Diagram took too long to render", { cause: error });
    }
    throw error;
  }
  if (result.svg.length > maxOutputChars) throw new Error("Rendered diagram is too large");
  return result;
}

/**
 * Key for cached render output. Renderer identity, version and theme are part of it, so a
 * renderer upgrade invalidates cached output; none of it is part of a comment's anchor.
 */
export function diagramCacheKey(key: {
  blobOid: string;
  /** Source offsets of the whole fence. */
  range: { start: number; end: number };
  renderer: Pick<DiagramRenderer, "id" | "version">;
  theme: DiagramTheme;
}): string {
  const { blobOid, range, renderer, theme } = key;
  return [blobOid, `${range.start}-${range.end}`, renderer.id, renderer.version, theme].join(":");
}
