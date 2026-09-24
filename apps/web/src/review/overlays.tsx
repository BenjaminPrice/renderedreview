// SPDX-License-Identifier: AGPL-3.0-only
// Overlays drawn in the document column: connector lines (pinned rail) and margin markers (collapsed rail).
import type { Ref } from "react";
import { connectorPath, type ThreadState, type Wire } from "./model";
import { ReviewIcon, type ReviewIconName } from "./ThreadCard";

const DURATION = 240;
const STAGGER = 25;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ConnectorLayer({
  ref,
  wires,
  activeId,
}: {
  ref?: Ref<SVGSVGElement>;
  wires: Wire[];
  activeId?: string | null;
}) {
  // The active line is drawn last so it sits on top.
  const ordered = wires
    .map((w, i) => ({ w, d: connectorPath(w, i), on: w.id === activeId }))
    .sort((a, b) => +a.on - +b.on);
  return (
    <svg ref={ref} className="rr-wires" aria-hidden="true">
      {ordered.map(({ w, d, on }) => (
        <g key={w.id} className={on ? "rr-wire-on" : undefined}>
          <path d={d} />
          <circle cx={w.anchorX} cy={w.anchorY} r={3} />
        </g>
      ))}
    </svg>
  );
}

const parts = (svg: SVGSVGElement) => ({
  paths: [...svg.querySelectorAll("path")],
  dots: [...svg.querySelectorAll("circle")],
});

/** Draw each line from its card toward the anchor, then fade in the anchor dot. */
export function drawIn(svg: SVGSVGElement | null) {
  if (!svg || reduceMotion()) return;
  const { paths, dots } = parts(svg);
  for (const p of paths) {
    const length = String(p.getTotalLength());
    Object.assign(p.style, { transition: "none", strokeDasharray: length, strokeDashoffset: length });
  }
  for (const c of dots) Object.assign(c.style, { transition: "none", opacity: "0" });
  svg.getBoundingClientRect(); // commit the start state before transitioning
  paths.forEach((p, i) => {
    Object.assign(p.style, {
      transition: `stroke-dashoffset ${DURATION}ms ease-out ${i * STAGGER}ms`,
      strokeDashoffset: "0",
    });
  });
  dots.forEach((c, i) => {
    Object.assign(c.style, { transition: `opacity 80ms linear ${DURATION + i * STAGGER - 40}ms`, opacity: "1" });
  });
  // Clear the dash so later redraws (resize, filters) show whole lines.
  setTimeout(() => paths.forEach((p) => p.style.removeProperty("stroke-dasharray")), DURATION + paths.length * STAGGER);
}

/** Retract the lines toward their cards. Resolves when they are gone. */
export function drawOut(svg: SVGSVGElement | null): Promise<void> {
  if (!svg || reduceMotion() || !svg.querySelector("path")) return Promise.resolve();
  const { paths, dots } = parts(svg);
  for (const c of dots) Object.assign(c.style, { transition: "opacity 60ms linear", opacity: "0" });
  for (const p of paths) {
    const length = String(p.getTotalLength());
    Object.assign(p.style, { transition: "none", strokeDasharray: length, strokeDashoffset: "0" });
  }
  svg.getBoundingClientRect();
  for (const p of paths)
    Object.assign(p.style, {
      transition: `stroke-dashoffset ${DURATION}ms ease-in`,
      strokeDashoffset: p.style.strokeDasharray,
    });
  return new Promise((resolve) => setTimeout(resolve, DURATION));
}

export interface Marker {
  threadId: string;
  state: ThreadState;
  count: number;
  /** Offset from the document container's top. */
  top: number;
  left: number;
  active: boolean;
}

const MARKER_ICON: Record<ThreadState, ReviewIconName> = {
  current: "comment",
  resolved: "check",
  outdated: "warn",
  historical: "history",
};

/** State-aware comment counts beside each anchor while the rail is collapsed. */
export function MarginMarkers({ markers, onOpen }: { markers: Marker[]; onOpen: (threadId: string) => void }) {
  return markers.map((m) => (
    <button
      key={m.threadId}
      type="button"
      className={`rr-marker rr-marker-${m.state}${m.active ? " rr-marker-active" : ""}`}
      style={{ top: m.top, left: m.left }}
      aria-label={`${m.count} comment${m.count === 1 ? "" : "s"}, ${m.state}. Open in comment rail`}
      aria-controls="rr-rail"
      onClick={() => onOpen(m.threadId)}
    >
      <ReviewIcon name={MARKER_ICON[m.state]} />
      {m.count}
    </button>
  ));
}
