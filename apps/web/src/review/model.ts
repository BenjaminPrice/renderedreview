// SPDX-License-Identifier: AGPL-3.0-only
// Pure logic behind the comment rail: thread states, filters, labels, card layout and connector
// geometry. No DOM access, so it is unit-tested directly.
import type { NativeAnchor, NativeThread, RepositoryRef } from "@rendered-review/review-domain";

/** Filter bucket of a thread. `historical` stays empty until annotation re-anchoring exists. */
export type ThreadState = "current" | "resolved" | "outdated" | "historical";

export const THREAD_STATES: ThreadState[] = ["current", "resolved", "outdated", "historical"];

/** Current, resolved and outdated are shown by default; historical is opt-in. */
export const DEFAULT_FILTERS: ReadonlySet<ThreadState> = new Set(["current", "resolved", "outdated"]);

export function threadState(thread: NativeThread): ThreadState {
  if (thread.resolution === "resolved") return "resolved";
  return thread.anchor.type === "outdated" ? "outdated" : "current";
}

export function filterCounts(threads: NativeThread[]): Record<ThreadState, number> {
  const counts = { current: 0, resolved: 0, outdated: 0, historical: 0 };
  for (const t of threads) counts[threadState(t)]++;
  return counts;
}

// ponytail: REST has no edit timestamp; comments submitted with a pending review also get a later
// updated_at. GraphQL `lastEditedAt` is exact if this threshold misleads.
const EDIT_THRESHOLD_MS = 60_000;

/** GitHub bumps `updatedAt` a little on creation; only a later change counts as an edit. */
export function isEdited(c: { createdAt: string; updatedAt: string }): boolean {
  return Date.parse(c.updatedAt) - Date.parse(c.createdAt) > EDIT_THRESHOLD_MS;
}

const lines = (a: { startLine: number; endLine: number }) =>
  a.startLine === a.endLine ? `L${a.startLine}` : `L${a.startLine}–L${a.endLine}`;

/** Location label. GitHub gives lines only, so it never claims a word-level selection. */
export function anchorLabel(anchor: NativeAnchor): string {
  if (anchor.type === "file") return "File-level review comment";
  return `GitHub line comment · ${lines(anchor)}${anchor.side === "LEFT" ? " (base)" : ""}`;
}

/** Permalink to the lines a thread was written against. */
export function blobUrl(
  repo: RepositoryRef,
  sha: string,
  path: string,
  range?: { startLine: number; endLine: number },
) {
  const file = path.split("/").map(encodeURIComponent).join("/");
  const hash = range ? `#${lines(range).replace("–", "-")}` : "";
  return `https://${repo.host}/${repo.owner}/${repo.name}/blob/${sha}/${file}${hash}`;
}

/**
 * The lines a suggestion replaces: the last `count` head-side lines of the comment's diff hunk
 * (GitHub ends the hunk at the commented line). Deleted (`-`) lines are not on the head side.
 */
export function suggestionOriginal(diffHunk: string, count: number): string[] {
  const body = diffHunk.split("\n").filter((l) => !l.startsWith("@@") && !l.startsWith("-") && !l.startsWith("\\"));
  return body.slice(-count).map((l) => l.slice(1));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

export function relativeTime(iso: string, now = Date.now(), locale?: string): string {
  const seconds = (Date.parse(iso) - now) / 1000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  for (const [unit, size] of UNITS)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, "second");
}

export interface LayoutItem {
  id: string;
  /** Desired top: the anchor's offset from the layout container. */
  anchorTop: number;
  height: number;
}

/**
 * Place items at their anchors in anchor order, pushing each down just enough to clear the
 * previous one. Never overlaps, never moves an item above its anchor or above 0.
 */
export function layoutCards(items: LayoutItem[], gap: number): { tops: Map<string, number>; height: number } {
  const tops = new Map<string, number>();
  let next = 0;
  for (const item of [...items].sort((a, b) => a.anchorTop - b.anchorTop)) {
    const top = Math.max(item.anchorTop, next);
    tops.set(item.id, top);
    next = top + item.height + gap;
  }
  return { tops, height: Math.max(0, next - gap) };
}

export interface Wire {
  id: string;
  /** Point on the card's left edge. */
  cardX: number;
  cardY: number;
  /** Anchor dot in the document margin. */
  anchorX: number;
  anchorY: number;
}

export const LANE_OFFSET = 10;
export const LANE_STEP = 5;

/**
 * Elbow path: out of the card to its gutter lane, along the lane to the anchor's height, then
 * into the margin dot. Lanes are staggered by index so parallel runs stay distinguishable, and
 * never cross the dot.
 */
export function connectorPath(w: Wire, index: number): string {
  const lane = Math.max(w.cardX - LANE_OFFSET - index * LANE_STEP, w.anchorX + LANE_STEP);
  return `M${w.cardX} ${w.cardY}H${lane}V${w.anchorY}H${w.anchorX}`;
}
