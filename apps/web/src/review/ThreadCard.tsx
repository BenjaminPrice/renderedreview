// SPDX-License-Identifier: AGPL-3.0-only
import type { Actor, ReviewComment } from "@rendered-review/github-integration";
import type { NativeThread, RepositoryRef } from "@rendered-review/review-domain";
import type { ReactNode } from "react";
import { Markdown } from "./Markdown";
import { anchorLabel, blobUrl, isEdited, relativeTime, suggestionOriginal, threadState } from "./model";

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

function Comment({ comment, thread, badges }: { comment: ReviewComment; thread: NativeThread; badges?: ReactNode }) {
  const a = thread.anchor;
  const suggestion =
    a.type === "file"
      ? undefined
      : {
          original: a.side === "RIGHT" ? suggestionOriginal(comment.diffHunk, a.endLine - a.startLine + 1) : null,
          href: comment.htmlUrl,
        };
  return (
    <div className="rr-c">
      <CommentHead author={comment.author} createdAt={comment.createdAt} updatedAt={comment.updatedAt}>
        {badges}
      </CommentHead>
      <Markdown source={comment.body} suggestion={suggestion} />
    </div>
  );
}

export interface ThreadCardProps {
  thread: NativeThread;
  repository: RepositoryRef;
  active?: boolean;
  onActivate?: () => void;
}

/** One native review thread. Resolved threads collapse in place; unknown resolution claims nothing. */
export function ThreadCard({ thread, repository, active, onActivate }: ThreadCardProps) {
  const state = threadState(thread);
  const a = thread.anchor;
  const root = thread.comments[0]!;
  const label = anchorLabel(a);
  const n = thread.comments.length;

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
  const badges = (outdated || unresolved) && (
    <>
      {outdated}
      {unresolved}
    </>
  );
  const body = (
    <>
      {thread.comments.map((c, i) => (
        <Comment key={c.id} comment={c} thread={thread} badges={i === 0 && state !== "resolved" ? badges : null} />
      ))}
      <div className="rr-t-foot">
        <span className="rr-t-loc">
          {a.type === "outdated" ? (
            <>
              From <code>{a.commitOid.slice(0, 7)}</code> · {label.replace("GitHub line comment · ", "")}
            </>
          ) : (
            label
          )}
        </span>
        <span className="rr-spacer" />
        {a.type === "outdated" && (
          <a
            className="rr-btn rr-btn-sm rr-btn-ghost"
            href={blobUrl(repository, a.commitOid, thread.path, a)}
            target="_blank"
            rel="noreferrer"
          >
            View in original
          </a>
        )}
        <a className="rr-btn rr-btn-sm rr-btn-ghost" href={root.htmlUrl} target="_blank" rel="noreferrer">
          View on GitHub
        </a>
      </div>
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
  const who = root.author?.login ?? "ghost";

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
    <section {...common} aria-label={`${label}, by ${who}${a.type === "outdated" ? ", outdated" : ""}`}>
      {body}
    </section>
  );
}
