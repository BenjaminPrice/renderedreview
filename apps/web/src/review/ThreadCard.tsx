// SPDX-License-Identifier: AGPL-3.0-only
import type { Actor } from "@rendered-review/github-integration";
import {
  displayBody,
  type NativeAnchor,
  type NativeThread,
  type RepositoryRef,
  type ThreadComment,
} from "@rendered-review/review-domain";
import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { ExternalLink } from "../ui/ExternalLink";
import { Markdown } from "./Markdown";
import { anchorLabel, blobUrl, isEdited, lines, relativeTime, suggestionOriginal, threadState } from "./model";
import type { ThreadActions } from "./thread-actions";
import { ThreadFoot } from "./ThreadFoot";

/** DOM id of a thread card. Anchors point at it with `aria-details`. */
export const threadDomId = (threadId: string) => `rr-thread-${threadId.replace(/[^\w-]/g, "_")}`;

export const initials = (login: string) =>
  login
    .replace(/\[bot\]$/, "")
    .slice(0, 2)
    .toUpperCase();

export function Avatar({ actor }: { actor: Actor | null }) {
  return (
    <span className="rr-avatar rr-avatar-sm" aria-hidden="true">
      {actor ? initials(actor.login) : "?"}
    </span>
  );
}

/** Author, relative time (full time on hover) and the "Edited on GitHub" note. */
export function CommentHead({
  author,
  createdAt,
  updatedAt,
  children,
}: {
  author: Actor | null;
  createdAt: string;
  updatedAt: string;
  children?: ReactNode;
}) {
  return (
    <div className="rr-c-head">
      <Avatar actor={author} />
      <span className="rr-c-who">{author?.login ?? "ghost"}</span>
      <time className="rr-c-when" dateTime={createdAt} title={new Date(createdAt).toLocaleString()}>
        {relativeTime(createdAt)}
      </time>
      {isEdited({ createdAt, updatedAt }) && (
        <span className="rr-edited" title={`Edited on GitHub ${new Date(updatedAt).toLocaleString()}`}>
          Edited on GitHub
        </span>
      )}
      {children && <span className="rr-badges">{children}</span>}
    </div>
  );
}

const ICONS = {
  comment: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  check: "M3 8.5l3 3 7-7",
  warn: "M8 2l6.5 11.5h-13zM8 6.5v3.5M8 12v.01",
  history: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5",
  change: "M8 3v10M3 8h10",
  dismiss: "M4 4l8 8M12 4l-8 8",
  dot: "M8 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3",
};
export type ReviewIconName = keyof typeof ICONS;

export function ReviewIcon({ name }: { name: ReviewIconName }) {
  return (
    <svg className="rr-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Badges carry text and an icon, never colour alone. */
export function Badge({
  tone,
  icon,
  children,
}: {
  tone: "neutral" | "accent" | "added" | "mod" | "del";
  icon?: ReviewIconName;
  children: ReactNode;
}) {
  return (
    <span className={`rr-badge rr-b-${tone}`}>
      {icon && <ReviewIcon name={icon} />}
      {children}
    </span>
  );
}

/** Small notice that a comment's metadata could not be used; `reason` on hover. */
export function MetadataNotice({ state, reason }: { state: "damaged" | "unsupported"; reason?: string }) {
  return (
    <span title={reason}>
      <Badge tone="mod" icon="warn">
        {state === "damaged" ? "Metadata damaged" : "Unsupported version"}
      </Badge>
    </span>
  );
}

function Comment({
  comment,
  anchor,
  body,
  badges,
}: {
  comment: ThreadComment;
  anchor: NativeAnchor;
  body: string;
  badges?: ReactNode;
}) {
  const suggestion =
    anchor.type === "current" || anchor.type === "outdated"
      ? {
          original:
            anchor.side === "RIGHT" && "diffHunk" in comment
              ? suggestionOriginal(comment.diffHunk, anchor.endLine - anchor.startLine + 1)
              : null,
          href: comment.htmlUrl,
        }
      : undefined;
  return (
    <div className="rr-c">
      <CommentHead author={comment.author} createdAt={comment.createdAt} updatedAt={comment.updatedAt}>
        {badges}
      </CommentHead>
      <Markdown source={body} suggestion={suggestion} />
    </div>
  );
}

export interface ThreadCardProps {
  thread: NativeThread;
  repository: RepositoryRef;
  active?: boolean;
  /** A current line comment that maps to no rendered block (e.g. a blank line); its label says so. */
  unplaced?: boolean;
  /** Why the thread is not placed (e.g. its document changed), shown with its location. */
  reason?: string;
  /** Its annotation was verified against the displayed document: the quote it repeats is hidden. */
  verified?: boolean;
  /** Its annotation does not match the document it names: why. */
  damaged?: string;
  /** Re-anchored from an earlier revision to these lines of the displayed document; `approximate` when its text changed. */
  moved?: { startLine: number; endLine: number; approximate?: boolean };
  /** Its words are only in the revision it was written on. */
  historical?: boolean;
  /**
   * In-app link to the revision the thread was written on. Without it, an outdated thread links
   * to its original lines on GitHub instead.
   */
  original?: { href: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void };
  onActivate?: () => void;
  /** Reply and resolve controls; without them the card is read-only. */
  actions?: ThreadActions;
  /** Starts repairing the anchor of the viewer's own comment; offered only when given. */
  onRepair?: () => void;
}

/** One native review thread. Resolved threads collapse in place; unknown resolution claims nothing. */
export function ThreadCard({
  thread,
  repository,
  active,
  unplaced,
  reason,
  verified,
  damaged,
  moved,
  historical,
  original,
  onActivate,
  actions,
  onRepair,
}: ThreadCardProps) {
  const state = historical && threadState(thread) !== "resolved" ? "historical" : threadState(thread);
  // An annotation not verified against this document is shown at its GitHub line, when it has one.
  const a =
    thread.anchor.type === "annotation" && !verified && thread.anchor.fallback ? thread.anchor.fallback : thread.anchor;
  const root = thread.comments[0]!;
  const label = moved ? `Selected text · ${lines(moved)}` : anchorLabel(a);
  const n = thread.comments.length;
  const who = root.author?.login ?? "ghost";

  // Resolving collapses the card into a new element (and reopening expands it): keep focus on it.
  const resolving = useRef(false);
  useEffect(() => {
    if (!resolving.current) return;
    resolving.current = false;
    const card = document.getElementById(threadDomId(thread.id));
    (card?.querySelector("summary") ?? card)?.focus();
  }, [state, thread.id]);

  const outdated = a.type === "outdated" && (
    <Badge tone="mod" icon="warn">
      Outdated
    </Badge>
  );
  const unresolved = thread.resolution === "unresolved" && (
    <Badge tone="accent" icon="dot">
      Unresolved
    </Badge>
  );
  const movedBadge = moved && (
    <Badge tone="mod" icon="history">
      Moved
    </Badge>
  );
  const historicalBadge = state === "historical" && (
    <Badge tone="neutral" icon="history">
      Historical
    </Badge>
  );
  const badges = (outdated || movedBadge || historicalBadge || unresolved) && (
    <>
      {outdated}
      {movedBadge}
      {historicalBadge}
      {unresolved}
    </>
  );
  const body = (
    <>
      {thread.comments.map((c, i) => {
        const meta = thread.metadata?.[c.id];
        const notice =
          meta?.state === "damaged" || meta?.state === "unsupported" ? (
            <MetadataNotice state={meta.state} reason={meta.reason} />
          ) : (
            i === 0 && damaged && <MetadataNotice state="damaged" reason={damaged} />
          );
        return (
          <Comment
            key={c.id}
            comment={c}
            anchor={a}
            body={displayBody(thread, c, !!verified)}
            badges={
              (notice || (i === 0 && state !== "resolved" && badges)) && (
                <>
                  {notice}
                  {i === 0 && state !== "resolved" && badges}
                </>
              )
            }
          />
        );
      })}
      {thread.events && (
        <ol className="rr-t-events" aria-label="Thread events">
          {thread.events.map((e) => (
            <li key={e.comment.id}>
              <ReviewIcon name={e.resolution === "resolved" ? "check" : "dot"} />
              <b>{e.comment.author?.login ?? "ghost"}</b> {e.resolution} this thread ·{" "}
              <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                {relativeTime(e.at)}
              </time>
              {e.ignored && " · doesn't change the thread state"}
            </li>
          ))}
        </ol>
      )}
      <ThreadFoot thread={thread} actions={actions} context={`thread by ${who}, ${label}`} resolving={resolving}>
        <span className="rr-t-loc">
          {reason ? (
            `${label} · ${reason}`
          ) : moved?.approximate ? (
            `${label} · Text changed since this comment · approximate location`
          ) : a.type === "outdated" ? (
            <>
              From <code>{a.commitOid.slice(0, 7)}</code> · {label.replace("GitHub line comment · ", "")}
            </>
          ) : unplaced && a.type === "current" ? (
            `${label} · no rendered block at this line`
          ) : (
            label
          )}
        </span>
        <span className="rr-spacer" />
        {onRepair && (
          <button
            type="button"
            className="rr-btn rr-btn-sm rr-btn-ghost"
            aria-label={`Repair anchor of thread by ${who}, ${label}`}
            onClick={onRepair}
          >
            Repair anchor
          </button>
        )}
        {original ? (
          <a className="rr-btn rr-btn-sm rr-btn-ghost" href={original.href} onClick={original.onClick}>
            View in original
          </a>
        ) : (
          a.type === "outdated" && (
            <ExternalLink
              className="rr-btn rr-btn-sm rr-btn-ghost"
              href={blobUrl(repository, a.commitOid, thread.path, a)}
            >
              View in original
            </ExternalLink>
          )
        )}
        <ExternalLink className="rr-btn rr-btn-sm rr-btn-ghost" href={root.htmlUrl}>
          View on GitHub
        </ExternalLink>
      </ThreadFoot>
    </>
  );

  const common = {
    id: threadDomId(thread.id),
    className: `rr-thread${active ? " rr-thread-active" : ""}`,
    "data-state": state,
    tabIndex: -1,
    onFocus: onActivate,
    onClick: onActivate,
  };

  if (state === "resolved")
    return (
      <details {...common}>
        <summary aria-label={`Resolved thread by ${who}, ${n} comment${n === 1 ? "" : "s"}. ${label}`}>
          <svg className="rr-icon rr-chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 4l4 4-4 4" />
          </svg>
          <Badge tone="added" icon="check">
            Resolved
          </Badge>
          <span>
            {who} · {n} comment{n === 1 ? "" : "s"}
          </span>
          {outdated}
        </summary>
        {body}
      </details>
    );

  return (
    <section
      {...common}
      aria-label={`${label}, by ${who}${a.type === "outdated" ? ", outdated" : moved ? ", moved" : historical ? ", historical" : ""}`}
    >
      {body}
    </section>
  );
}
