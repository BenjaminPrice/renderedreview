// SPDX-License-Identifier: AGPL-3.0-only
// The comment rail for one rendered document: threads aligned to their anchors (pinned), a packed
// list (slide-over), margin markers (collapsed) and optional connector lines.
import type { RepositoryRef, ThreadPlacement } from "@rendered-review/review-domain";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useShell } from "../ui/AppShell";
import { layoutCards, THREAD_STATES, threadState, type ThreadState, type Wire } from "./model";
import { ConnectorLayer, drawIn, drawOut, MarginMarkers, type Marker } from "./overlays";
import { ThreadCard, threadDomId } from "./ThreadCard";

const CARD_GAP = 10;
const MARKER_HEIGHT = 24;
const MARKER_GAP = 4;

export interface CommentRailProps {
  /** Threads of the displayed document, from `placeThreads`. Threads without blocks are listed unanchored. */
  placements: ThreadPlacement[];
  repository: RepositoryRef;
  filters: ReadonlySet<ThreadState>;
  /**
   * The positioned element holding the rendered document (e.g. `.rr-doc`), inside the same scroll
   * container as the rail. Markers and connectors are drawn in it; anchors are measured against it.
   */
  docContainerRef: RefObject<HTMLElement | null>;
  /** Element of a rendered block. Defaults to `[data-rr-id="<id>"]` inside the document container. */
  getAnchorElement?: (rrId: number) => Element | null;
  /** Controlled active thread; highlight its anchor with the same id. Uncontrolled when omitted. */
  activeThreadId?: string | null;
  onActiveThreadChange?: (threadId: string | null) => void;
}

export function CommentRail(props: CommentRailProps) {
  const { placements, repository, filters, docContainerRef, getAnchorElement } = props;
  const shell = useShell();
  const pinned = shell.railMode === "pinned";
  const [localActive, setLocalActive] = useState<string | null>(null);
  const active = props.activeThreadId !== undefined ? props.activeThreadId : localActive;
  const activate = (id: string | null) => {
    setLocalActive(id);
    props.onActiveThreadChange?.(id);
  };

  const [doc, setDoc] = useState<HTMLElement | null>(null);
  useEffect(() => setDoc(docContainerRef.current), [docContainerRef]);

  const visible = placements.filter((p) => filters.has(threadState(p.thread)));
  const unanchored = visible.filter((p) => !p.blocks.length);
  // Unanchored threads are listed after the aligned ones so they don't push every card off its anchor.
  // rr ids are in document order, so this is also reading and tab order.
  const anchored = visible.filter((p) => p.blocks.length).sort((a, b) => a.blocks[0]!.id - b.blocks[0]!.id);

  const alignedRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);

  const relayout = useCallback(() => {
    const box = alignedRef.current;
    if (!doc || !box) return;
    const find = getAnchorElement ?? ((id: number) => doc.querySelector(`[data-rr-id="${id}"]`));
    const origin = doc.getBoundingClientRect();
    // Right edge of the text column; the document's right padding is the marker and connector gutter.
    const textRight = origin.width - parseFloat(getComputedStyle(doc).paddingRight);
    const rows = anchored.map((p) => ({
      id: p.thread.id,
      anchor: find(p.blocks[0]!.id)?.getBoundingClientRect(),
      card: document.getElementById(threadDomId(p.thread.id)),
      count: p.thread.comments.length,
      state: threadState(p.thread),
    }));

    if (!pinned) {
      box.style.height = "";
      rows.forEach((r) => r.card?.style.removeProperty("top"));
      const placed = rows.filter((r) => r.anchor);
      const { tops } = layoutCards(
        placed.map((r) => ({ id: r.id, anchorTop: r.anchor!.top - origin.top + 2, height: MARKER_HEIGHT })),
        MARKER_GAP,
      );
      setMarkers(
        placed.map((r) => ({
          threadId: r.id,
          state: r.state,
          count: r.count,
          top: tops.get(r.id)!,
          left: textRight + 8,
          active: r.id === active,
        })),
      );
      setWires([]);
      return;
    }

    const boxRect = box.getBoundingClientRect();
    const { tops, height } = layoutCards(
      rows.map((r) => ({
        id: r.id,
        anchorTop: r.anchor ? r.anchor.top - boxRect.top - 6 : 0,
        height: r.card?.offsetHeight ?? 0,
      })),
      CARD_GAP,
    );
    box.style.height = `${height}px`;
    for (const r of rows) if (r.card) r.card.style.top = `${tops.get(r.id)}px`;

    // From the computed tops, not measured: cards animate to their new position.
    setWires(
      rows.flatMap((r) =>
        r.anchor && r.card
          ? [
              {
                id: r.id,
                cardX: boxRect.left + r.card.offsetLeft - origin.left,
                cardY: boxRect.top + tops.get(r.id)! - origin.top + 18,
                anchorX: textRight + 12,
                anchorY: r.anchor.top - origin.top + Math.min(r.anchor.height / 2, 13),
              },
            ]
          : [],
      ),
    );
    setMarkers([]);
    // `anchored` is derived from these props each render.
  }, [doc, getAnchorElement, pinned, active, placements, filters]);

  useLayoutEffect(relayout, [relayout]);

  // Re-align whenever the document or any card changes size (content load, resize, expanding a thread).
  useEffect(() => {
    const box = alignedRef.current;
    if (!doc || !box) return;
    const observer = new ResizeObserver(() => relayout());
    observer.observe(doc);
    observer.observe(box.parentElement!);
    for (const card of box.children) observer.observe(card);
    return () => observer.disconnect();
  }, [doc, relayout]);

  // Connectors: pinned rail only, and only when the user turned them on.
  const showWires = shell.connectors && pinned;
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (showWires) {
      setDrawn(true);
      // Two frames: the rail must be laid out and the paths rendered before they animate.
      requestAnimationFrame(() => requestAnimationFrame(() => drawIn(svgRef.current)));
      return;
    }
    // A retraction overtaken by a redraw (switched back on, re-pinned) must not remove the new lines.
    let current = true;
    void drawOut(svgRef.current).then(() => current && setDrawn(false));
    return () => {
      current = false;
    };
  }, [showWires]);
  useEffect(() => {
    shell.setBeforeCollapse(showWires ? () => drawOut(svgRef.current) : null);
    return () => shell.setBeforeCollapse(null);
    // `shell` is rebuilt each render; the setter only writes a ref.
  }, [showWires]);

  // Focus a thread in the rail, opening the slide-over first when the rail is collapsed.
  const pendingFocus = useRef<string | null>(null);
  const focusThread = useCallback((id: string) => {
    const card = document.getElementById(threadDomId(id));
    if (!card) return;
    if (card instanceof HTMLDetailsElement) card.open = true;
    card.scrollIntoView({ block: "nearest" });
    card.focus({ preventScroll: true });
  }, []);
  const openThread = (id: string) => {
    activate(id);
    if (shell.railMode === "collapsed") {
      pendingFocus.current = id;
      shell.openRail();
    } else requestAnimationFrame(() => focusThread(id));
  };
  useEffect(() => {
    if (shell.railMode !== "slide" || !pendingFocus.current) return;
    const id = pendingFocus.current;
    pendingFocus.current = null;
    requestAnimationFrame(() => focusThread(id));
  }, [shell.railMode, focusThread]);

  // Activation from outside (an anchor was selected) focuses its thread. Only a change of the
  // active thread triggers this; the rail mode is read when it happens.
  const onActiveChange = useEffectEvent((id: string | null) => {
    const card = id && document.getElementById(threadDomId(id));
    if (card && !card.contains(document.activeElement)) openThread(id);
  });
  useEffect(() => onActiveChange(active), [active]);

  const card = (p: ThreadPlacement) => (
    <ThreadCard
      key={p.thread.id}
      thread={p.thread}
      repository={repository}
      active={p.thread.id === active}
      onActivate={() => p.thread.id !== active && activate(p.thread.id)}
    />
  );

  return (
    <div className="rr-rail-body">
      {!placements.length ? (
        <p className="rr-rail-empty">No review comments on this document.</p>
      ) : (
        !visible.length && <p className="rr-rail-empty">No comments match the selected filters.</p>
      )}
      <div ref={alignedRef} className="rr-rail-aligned">
        {anchored.map(card)}
      </div>
      {unanchored.length > 0 && (
        <section className="rr-rail-group" aria-labelledby="rr-rail-unanchored">
          <h3 id="rr-rail-unanchored" className="rr-rail-group-title">
            File-level and outdated
          </h3>
          {unanchored.map(card)}
        </section>
      )}
      {doc &&
        createPortal(
          <>
            {drawn && <ConnectorLayer ref={svgRef} wires={wires} activeId={active} />}
            {!pinned && <MarginMarkers markers={markers} onOpen={openThread} />}
          </>,
          doc,
        )}
    </div>
  );
}

const STATE_LABEL: Record<ThreadState, string> = {
  current: "Current",
  resolved: "Resolved",
  outdated: "Outdated",
  historical: "Historical",
};

export interface RailHeaderProps {
  counts: Record<ThreadState, number>;
  filters: ReadonlySet<ThreadState>;
  onFiltersChange: (filters: ReadonlySet<ThreadState>) => void;
}

/** Rail header content (AppShell `railHeader`): the connector preference and the state filters. */
export function RailHeader({ counts, filters, onFiltersChange }: RailHeaderProps) {
  const shell = useShell();
  const toggle = (state: ThreadState) => {
    const next = new Set(filters);
    if (!next.delete(state)) next.add(state);
    onFiltersChange(next);
  };
  return (
    <div className="rr-rail-controls">
      {/* Connectors only apply to the aligned (pinned) rail, not the slide-over's packed list. */}
      {shell.railMode !== "slide" && (
        <div className="rr-prefs" role="group" aria-label="User preferences">
          <button
            type="button"
            className="rr-switch"
            role="switch"
            aria-checked={shell.connectors}
            onClick={() => shell.setConnectors(!shell.connectors)}
          >
            <span className="rr-switch-track" aria-hidden="true">
              <span className="rr-switch-knob" />
            </span>
            Show connectors
          </button>
          <span className="rr-pref-note">· your preference</span>
        </div>
      )}
      <div className="rr-filters" role="group" aria-label="Filter comments">
        {THREAD_STATES.map((state) => (
          <button
            key={state}
            type="button"
            className="rr-chip"
            aria-pressed={filters.has(state)}
            onClick={() => toggle(state)}
          >
            {STATE_LABEL[state]} <span className="rr-chip-n">{counts[state]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
