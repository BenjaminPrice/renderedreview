// SPDX-License-Identifier: AGPL-3.0-only
// The PR Overview: the pull request itself (header band, description, conversation timeline),
// the documents-with-comments rail beside it, and the toolbar breadcrumbs of both views.
import type { Actor, PullRequest, Review } from "@rendered-review/github-integration";
import type { ResourceOptions } from "@rendered-review/markdown-domain";
import {
  anchorLines,
  type InferredLocation,
  type NativeThread,
  type RepositoryRef,
  type TimelineItem,
} from "@rendered-review/review-domain";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import type { PrIdentity } from "../github/queries";
import { isMarkdownPath } from "../pr-url";
import { filterCounts, Markdown, THREAD_STATES } from "../review";
import { blobUrl, relativeTime } from "../review/model";
import { Badge, initials, MetadataNotice, ReviewIcon, type ReviewIconName } from "../review/ThreadCard";
import { Icon } from "../ui/AppShell";
import { ExternalLink } from "../ui/ExternalLink";
import { inAppDocLink, useInAppLinks } from "./document";
import { type DocEntry, STATUS_LETTER } from "./docs";

const ROUTE = "/$host/$owner/$repo/pull/$number";

export type PrState = "open" | "merged" | "closed" | "draft";

export function prState(pr: PullRequest): { state: PrState; label: string } {
  if (pr.merged) return { state: "merged", label: "Merged" };
  if (pr.state === "closed") return { state: "closed", label: "Closed" };
  return pr.draft ? { state: "draft", label: "Draft" } : { state: "open", label: "Open" };
}

const lines = (a: { startLine: number; endLine: number }) =>
  a.startLine === a.endLine ? `L${a.startLine}` : `L${a.startLine}–L${a.endLine}`;

/** DOM id of a conversation comment in the timeline; `thread` links to it focus it. */
export const commentDomId = (id: string | number) => `rr-comment-${id}`;

function Avatar({ actor, className }: { actor: Actor | null; className: string }) {
  return (
    <span className={`rr-avatar ${className}`} aria-hidden="true">
      {actor ? initials(actor.login) : "?"}
    </span>
  );
}

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {relativeTime(at)}
    </time>
  );
}

export function PrOverview({
  pr,
  id,
  timeline,
  timelineError,
  focusCommentId,
}: {
  pr: PullRequest;
  id: PrIdentity;
  /** Undefined while loading. */
  timeline?: TimelineItem[];
  timelineError?: Error | null;
  /** Conversation comment to scroll to and focus (a `thread` link). */
  focusCommentId?: string | number;
}) {
  const { state, label } = prState(pr);
  const who = pr.author?.login ?? "ghost";
  const verb = pr.merged ? "merged" : pr.state === "open" ? "wants to merge" : "wanted to merge";
  const head =
    pr.head.repository && pr.head.repository.fullName !== pr.base.repository?.fullName
      ? `${pr.head.repository.owner}:${pr.head.ref}`
      : pr.head.ref;
  // Relative links in the description resolve against the PR head, Markdown files open here.
  const options = useMemo<ResourceOptions>(
    () => ({
      location: { host: id.host, owner: id.owner, repo: id.repo, commitOid: id.headSha, path: "" },
      resolveLink: (path, suffix) => inAppDocLink(id, path, suffix),
    }),
    [id],
  );
  const onClick = useInAppLinks();
  const repository = { host: id.host, owner: id.owner, name: id.repo };

  const loaded = !!timeline;
  useEffect(() => {
    if (!loaded || focusCommentId === undefined) return;
    const item = document.getElementById(commentDomId(focusCommentId));
    item?.scrollIntoView({ block: "start" });
    item?.focus({ preventScroll: true });
  }, [loaded, focusCommentId]);

  return (
    <div className="rr-overview" role="region" aria-label="Pull request overview">
      <div className="rr-pr-band">
        <div className="rr-eyebrow">
          <Icon name="pr" className={`rr-pr-${state}`} />
          Pull request
        </div>
        <h2 className="rr-ov-title">
          {pr.title} <span className="rr-pr-num">#{pr.number}</span>
        </h2>
        <div className="rr-pr-facts">
          <span className={`rr-pill rr-badge-${state}`}>
            <Icon name="pr" />
            {label}
          </span>
          <span>
            <b>{who}</b> {verb} {pr.commits} {pr.commits === 1 ? "commit" : "commits"} into
          </span>
          <code className="rr-branch">{pr.base.ref}</code>
          <span aria-hidden="true">←</span>
          <span className="rr-sr-only">from</span>
          <code className="rr-branch">{head}</code>
        </div>
        {pr.labels.length > 0 && (
          <ul className="rr-pr-facts rr-labels" aria-label="Labels">
            {pr.labels.map((l) => (
              <li key={l} className="rr-label">
                {l}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rr-overview-body">
        <section className="rr-desc" aria-labelledby="rr-desc-title">
          <div className="rr-desc-head">
            <Avatar actor={pr.author} className="rr-avatar-sm" />
            <h3 id="rr-desc-title">Description</h3>
            <span className="rr-muted">
              {who} · opened <When at={pr.createdAt} />
            </span>
            <span className="rr-spacer" />
            <ExternalLink className="rr-btn rr-btn-sm rr-btn-ghost" href={pr.htmlUrl}>
              Edit on GitHub
            </ExternalLink>
          </div>
          {/* Links inside navigate in-app when they point at this PR's documents. */}
          <div className="rr-desc-body" onClick={onClick}>
            {pr.body?.trim() ? (
              <Markdown source={pr.body} options={options} className="rr-markdown rr-desc-md" />
            ) : (
              <p className="rr-muted">No description provided.</p>
            )}
          </div>
        </section>

        <h3 className="rr-conv-h">Conversation {timeline && <span className="rr-count">{timeline.length}</span>}</h3>
        {timelineError ? (
          <p className="rr-muted">Could not load the conversation: {timelineError.message}</p>
        ) : !timeline ? (
          <p className="rr-muted">Loading conversation…</p>
        ) : !timeline.length ? (
          <p className="rr-muted">No conversation yet.</p>
        ) : (
          <ol className="rr-tl" aria-label="Conversation, oldest first">
            {timeline.map((item) =>
              item.kind === "comment" ? (
                <CommentItem key={`c${item.entry.comment.id}`} item={item} repository={repository} />
              ) : (
                <ReviewItem key={`r${item.review.id}`} item={item} />
              ),
            )}
          </ol>
        )}
      </div>
    </div>
  );
}

function Jump({ path, label, thread, hash }: { path: string; label: string; thread?: number; hash?: string }) {
  return (
    <Link from={ROUTE} search={(s) => ({ ...s, doc: path, view: undefined, thread })} hash={hash} className="rr-jump">
      <Icon name="jump" />
      Jump to {path} · {label}
    </Link>
  );
}

function InferredJump({ location: l, repository }: { location: InferredLocation; repository: RepositoryRef }) {
  // Only Markdown opens here; other files link to the permalink on GitHub.
  if (isMarkdownPath(l.path)) return <Jump path={l.path} label={lines(l)} hash={lines(l).replace("–", "-")} />;
  return (
    <ExternalLink href={blobUrl(repository, l.sha, l.path, l)}>
      {l.path} · {lines(l)} @ <code>{l.sha.slice(0, 7)}</code>
    </ExternalLink>
  );
}

function CommentItem({
  item: { entry },
  repository,
}: {
  item: Extract<TimelineItem, { kind: "comment" }>;
  repository: RepositoryRef;
}) {
  const { comment, inferred, metadata } = entry;
  const who = comment.author?.login ?? "ghost";
  return (
    <li id={commentDomId(comment.id)} className="rr-tl-item" tabIndex={-1} aria-label={`${who} commented`}>
      <Avatar actor={comment.author} className="rr-tl-av" />
      <div className="rr-tl-card">
        <div className="rr-tl-head">
          <span>
            <b>{who}</b> {comment.author?.type === "Bot" && <Badge tone="neutral">bot</Badge>} commented ·{" "}
            <When at={comment.createdAt} />
          </span>
          {inferred.length > 0 && (
            <span title="Location inferred from a GitHub permalink in the comment">
              <Badge tone="neutral">Inferred location</Badge>
            </span>
          )}
          {(metadata?.state === "damaged" || metadata?.state === "unsupported") && (
            <MetadataNotice state={metadata.state} reason={metadata.reason} />
          )}
          <span className="rr-spacer" />
          <ExternalLink className="rr-btn rr-btn-sm rr-btn-ghost" href={comment.htmlUrl}>
            View on GitHub
          </ExternalLink>
        </div>
        <div className="rr-tl-body">
          <Markdown source={comment.body} />
          {inferred.map((l) => (
            <p key={`${l.sha}:${l.path}:${l.startLine}-${l.endLine}`} className="rr-tl-meta">
              <InferredJump location={l} repository={repository} />
            </p>
          ))}
        </div>
      </div>
    </li>
  );
}

export const REVIEW_STATE: Record<
  Review["state"],
  { label: string; verb: string; icon: ReviewIconName; tone: "added" | "del" | "neutral" }
> = {
  APPROVED: { label: "Approved", verb: "approved these changes", icon: "check", tone: "added" },
  CHANGES_REQUESTED: { label: "Changes requested", verb: "requested changes", icon: "change", tone: "del" },
  COMMENTED: { label: "Commented", verb: "reviewed", icon: "comment", tone: "neutral" },
  DISMISSED: { label: "Dismissed", verb: "reviewed", icon: "dismiss", tone: "neutral" },
  PENDING: { label: "Pending", verb: "started a review", icon: "dot", tone: "neutral" },
};

function threadLabel(t: NativeThread) {
  const range = anchorLines(t.anchor);
  return range ? lines(range) : "file";
}

function ReviewItem({ item: { review, threads, at } }: { item: Extract<TimelineItem, { kind: "review" }> }) {
  const state = REVIEW_STATE[review.state];
  const who = review.author?.login ?? "ghost";
  const first = threads.find((t) => isMarkdownPath(t.path));
  const n = threads.length;
  return (
    <li className="rr-tl-item rr-tl-ev" aria-label={`${who} ${state.verb}`}>
      <span className={`rr-ev-icon rr-ev-${state.tone}`} aria-hidden="true">
        <ReviewIcon name={state.icon} />
      </span>
      <div className="rr-ev-row">
        <Avatar actor={review.author} className="rr-avatar-xs" />
        <b>{who}</b> {state.verb}
        <Badge tone={state.tone} icon={state.icon}>
          {state.label}
        </Badge>
        <When at={at} />
        <span className="rr-spacer" />
        <ExternalLink className="rr-btn rr-btn-sm rr-btn-ghost" href={review.htmlUrl}>
          View on GitHub
        </ExternalLink>
      </div>
      {(review.body.trim() || n > 0) && (
        <div className="rr-ev-body">
          {review.body.trim() && <Markdown source={review.body} />}
          {n > 0 && (
            <p className="rr-tl-meta">
              {n} review {n === 1 ? "comment" : "comments"}
              {first && (
                <>
                  {" · "}
                  <Jump path={first.path} label={threadLabel(first)} thread={first.comments[0]!.id} />
                </>
              )}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

const STATE_WORD = { current: "current", resolved: "resolved", outdated: "outdated", historical: "historical" };

/** Documents with comments, for the rail on Overview. Rows open the document. */
export function DocsWithComments({ threads, docs }: { threads: NativeThread[]; docs: DocEntry[] }) {
  const byPath = new Map<string, NativeThread[]>();
  for (const t of threads) if (isMarkdownPath(t.path)) byPath.set(t.path, [...(byPath.get(t.path) ?? []), t]);
  // Changed documents in sidebar order first, then the rest by path.
  const order = (p: string) => docs.findIndex((d) => d.path === p) >>> 0;
  const paths = [...byPath.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  if (!paths.length) return <p className="rr-rail-empty">No comments on documents.</p>;
  return (
    <div className="rr-rail-body">
      <ul className="rr-docsum">
        {paths.map((path) => {
          const list = byPath.get(path)!;
          const counts = filterCounts(list);
          const status = docs.find((d) => d.path === path)?.status ?? "unchanged";
          const summary = THREAD_STATES.filter((s) => counts[s])
            .map((s) => `${counts[s]} ${STATE_WORD[s]}`)
            .join(" · ");
          return (
            <li key={path}>
              <Link
                from={ROUTE}
                search={(s) => ({ ...s, doc: path, view: undefined, thread: undefined })}
                className="rr-file"
                aria-label={`${path}, ${summary}`}
              >
                <span className={`rr-status rr-status-${status}`} aria-hidden="true">
                  {STATUS_LETTER[status]}
                </span>
                <span className="rr-file-name">
                  <span className="rr-docsum-path">
                    {/* Long paths wrap after a slash. */}
                    {path.split("/").map((part, i) => (
                      <span key={i}>
                        {i > 0 && "/"}
                        {i > 0 && <wbr />}
                        {part}
                      </span>
                    ))}
                  </span>
                  <span className="rr-file-sub">{summary}</span>
                </span>
                <span className="rr-file-comments" aria-hidden="true">
                  <Icon name="comment" />
                  {list.length}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="rr-docsum-note">
        Connectors and margin markers apply inside documents only. Open a document to see its threads.
      </p>
    </div>
  );
}

/** Number of documents `DocsWithComments` lists. */
export const docsWithComments = (threads: NativeThread[]) =>
  new Set(threads.filter((t) => isMarkdownPath(t.path)).map((t) => t.path)).size;

export function OverviewCrumbs({ id, state }: { id: PrIdentity; state: PrState }) {
  return (
    <nav className="rr-crumbs" aria-label="Breadcrumb">
      <Icon name="repo" />
      <span>
        {id.owner}/{id.repo}
      </span>
      <span className="rr-crumb-sep" aria-hidden="true">
        ›
      </span>
      <span className="rr-crumb-pr">
        <Icon name="pr" className={`rr-pr-${state}`} />
        Pull request #{id.number}
      </span>
      <span className="rr-crumb-sep" aria-hidden="true">
        ›
      </span>
      <span className="rr-crumb-here" aria-current="page">
        Overview
      </span>
    </nav>
  );
}

export function DocumentCrumbs({ id, path }: { id: PrIdentity; path: string }) {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  return (
    <nav className="rr-crumbs rr-crumbs-doc" aria-label="Breadcrumb">
      <span>
        {id.owner}/{id.repo}
      </span>
      <span className="rr-crumb-sep" aria-hidden="true">
        ›
      </span>
      <Link from={ROUTE} search={(s) => ({ ...s, view: "overview" as const, doc: undefined, thread: undefined })}>
        #{id.number}
      </Link>
      <span className="rr-crumb-sep" aria-hidden="true">
        ›
      </span>
      <span className="rr-crumb-file" aria-current="page" title={path}>
        <Icon name="file" />
        <span className="rr-crumb-path">
          {dir}
          <b>{path.slice(dir.length)}</b>
        </span>
      </span>
    </nav>
  );
}
