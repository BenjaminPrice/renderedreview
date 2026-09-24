// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ChangedFile,
  ForbiddenError,
  NotFoundError,
  type PullRequest,
  RateLimitError,
} from "@rendered-review/github-integration";
import { blocksForLines, type RenderedMarkdown } from "@rendered-review/markdown-domain";
import {
  historicalThreads,
  type NativeThread,
  placeThreads,
  projectReview,
  reviewers,
  type ThreadPlacement,
} from "@rendered-review/review-domain";
import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, stripSearchParams, useLocation, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from "react";
import {
  MAX_RENDER_CHARS,
  nodeElement,
  RawDocument,
  RenderedDocument,
  type LoadedDocument,
  useDocument,
  useInAppLinks,
  useRevisionDocument,
} from "../document/document";
import { revisionOptions, revisionSource } from "../document/revisions";
import { allDocs, changedDocs, sourceUrl } from "../document/docs";
import {
  DocsWithComments,
  docsWithComments,
  DocumentCrumbs,
  OverviewCrumbs,
  PrOverview,
  prState,
} from "../document/Overview";
import { useAnchors } from "../document/anchors";
import { usePendingHighlight } from "../document/highlight";
import { SelectionPopover } from "../document/SelectionPopover";
import { Sidebar } from "../document/Sidebar";
import { ExternalLink } from "../ui/ExternalLink";
import { isPrivateRepoUnsupported, isSignInRequired, preferProxy, rateLimit } from "../github/client";
import { allowedHosts, proxyFirstHosts } from "../github/proxy";
import {
  blobQuery,
  changedFilesQuery,
  issueCommentsQuery,
  type PrIdentity,
  prIdentity,
  pullRequestCommitsQuery,
  pullRequestQuery,
  reviewCommentsQuery,
  reviewsQuery,
  reviewThreadsQuery,
  treeQuery,
  viewerQuery,
} from "../github/queries";
import { CommentRail, DEFAULT_FILTERS, placementCounts, RailHeader, type ThreadState } from "../review";
import { relativeTime } from "../review/model";
import { useReviewMode } from "../review/ReviewMode";
import { AppShell } from "../ui/AppShell";
import { GuestNotice } from "../ui/GuestNotice";
import { signIn } from "../ui/Viewer";
import { parsePrParams, validatePrSearch } from "../pr-url";

// Never exposes the read token itself, only which host it serves.
const getAllowedHosts = createServerFn({ method: "GET" }).handler(({ context: { config } }) => ({
  hosts: allowedHosts(config),
  proxyFirst: proxyFirstHosts(config),
}));

/** Deployment config: served GitHub hosts, and hosts to read through the proxy first. Fetched once per session. */
export const allowedHostsQuery = queryOptions({
  queryKey: ["allowed-hosts"],
  queryFn: () => getAllowedHosts(),
  staleTime: Infinity,
});

export const Route = createFileRoute("/$host/$owner/$repo/pull/$number")({
  params: {
    parse: (raw) => {
      const params = parsePrParams(raw);
      if (!params) throw notFound();
      return params;
    },
    stringify: (params) => ({ ...params, number: String(params.number) }),
  },
  loader: async ({ params, context }) => {
    const { hosts, proxyFirst } = await context.queryClient.ensureQueryData(allowedHostsQuery);
    proxyFirst.forEach(preferProxy);
    if (!hosts.includes(params.host)) throw notFound({ data: { unsupportedHost: params.host } });
  },
  validateSearch: validatePrSearch,
  // Keep shared links clean: the default sidebar mode is implied.
  search: { middlewares: [stripSearchParams({ files: "changed" })] },
  head: ({ params }) => ({ meta: [{ title: `${params.owner}/${params.repo}#${params.number} · Rendered Review` }] }),
  component: PullRequestPage,
  notFoundComponent: ({ data }) => {
    const host = (data as { unsupportedHost?: string } | undefined)?.unsupportedHost;
    return host ? (
      <Message title="Unsupported GitHub host">This server does not serve pull requests from {host}.</Message>
    ) : (
      <Message title="Not found">This is not a valid pull request link.</Message>
    );
  },
});

function PullRequestPage() {
  const params = Route.useParams();
  // Signed in, every read uses the viewer's own GitHub access; wait to know which.
  const viewer = useQuery(viewerQuery);
  const access = viewer.data?.signedIn ? "user" : "public";
  const pr = useQuery({ ...pullRequestQuery(params, access), enabled: viewer.isSuccess });
  const identity = pr.data && prIdentity(params.host, pr.data, access);
  // Placeholder identity while the PR loads; the query stays disabled until the real one exists.
  const files = useQuery({ ...changedFilesQuery(identity ?? ({} as PrIdentity)), enabled: !!identity });

  // Data already loaded stays on screen when a refetch fails (e.g. rate-limited).
  const error = pr.error ?? files.error;
  if ((!pr.data || !files.data) && error)
    return <ErrorState error={error} offerSignIn={viewer.data?.signInEnabled && !viewer.data.signedIn} />;
  if (!pr.data || !identity || !files.data) return <Message title="Loading…" />;
  return <ReviewPage pr={pr.data} id={identity} files={files.data} />;
}

function ReviewPage({ pr, id, files }: { pr: PullRequest; id: PrIdentity; files: ChangedFile[] }) {
  const search = Route.useSearch();
  const { docs: changed, otherCount } = useMemo(() => changedDocs(files), [files]);
  const review = useReview(id);
  // The active thread lives in the URL (`thread`: root comment id) so it can be shared.
  const threads = review.data?.threads;
  const active = threads?.find((t) => t.id === search.thread || t.comments.some((c) => c.id === search.thread));
  const threadIsComment = review.data?.conversation.some((e) => String(e.comment.id) === String(search.thread));
  // A document when the link names one, or one of its threads; otherwise (or asked for) the Overview.
  const path = search.view === "overview" || threadIsComment ? undefined : (search.doc ?? active?.path);
  const overview = path === undefined;
  const changedEntry = changed.find((d) => d.path === path);
  const tree = useQuery({
    ...treeQuery(id, id.headSha),
    enabled: search.files === "all" || (path !== undefined && !changedEntry),
  });
  const all = useMemo(() => tree.data && allDocs(tree.data, changed), [tree.data, changed]);
  const entry = changedEntry ?? all?.find((d) => d.path === path);
  const current = useDocument(id, entry);
  // `rev` names an earlier commit: the document as it was then, read-only. Its source depends on
  // the comments (an annotation's blob survives renames), so it waits for them.
  const revision = useMemo(
    () =>
      search.rev && entry && threads && search.rev !== current.sha
        ? revisionSource(threads, entry, search.rev, id.baseSha)
        : undefined,
    [search.rev, entry, threads, current.sha, id.baseSha],
  );
  const past = useRevisionDocument(id, entry, revision);
  const historical = !!search.rev && search.rev !== current.sha;
  // Never the current document under a historical banner: loading until the revision is known.
  const doc: LoadedDocument =
    past ?? (historical ? { tooLarge: false, changes: [], sha: search.rev!, error: review.error ?? null } : current);
  const commits = useQuery({ ...pullRequestCommitsQuery(id), enabled: !!entry });
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  // The rendered article, as state so the rail and anchors follow it across loads and view switches.
  const [article, setArticle] = useState<HTMLElement | null>(null);
  // The rail draws markers and connectors in the positioned document column around it.
  const docColumn = useMemo(() => ({ current: article?.parentElement ?? null }), [article]);

  const repository = useMemo(() => ({ host: id.host, owner: id.owner, name: id.repo }), [id]);
  const rendered = view === "rendered" ? doc.rendered : undefined;
  const firstPlacements = useMemo(() => {
    if (!review.data || !entry || historical) return [];
    // Deleted docs show the base revision, so only LEFT-side (base) lines can be placed.
    return placeThreads(
      review.data.threads,
      entry.path,
      entry.status === "deleted"
        ? { base: rendered }
        : { head: rendered, blob: doc.source === undefined ? undefined : { oid: entry.oid, source: doc.source } },
    );
  }, [review.data, entry, historical, rendered, doc.source]);
  const original = useOriginals(id, firstPlacements);
  const placements = useMemo(() => {
    if (!review.data || !entry) return [];
    if (past) {
      // Only the threads written on this revision, placed where they were written. A renamed
      // document's comments may name its old path.
      const onDoc = review.data.threads
        .filter((t) => t.path === entry.path || t.path === entry.previousPath)
        .map((t) => ({ ...t, path: entry.path }));
      const threads = historicalThreads(onDoc, { commitOid: past.sha, blobOid: past.blobOid });
      const blob = past.source === undefined ? undefined : { oid: past.blobOid ?? "", source: past.source };
      return placeThreads(threads, entry.path, { head: rendered, blob });
    }
    if (!original.size) return firstPlacements;
    return placeThreads(review.data.threads, entry.path, {
      head: rendered,
      blob: doc.source === undefined ? undefined : { oid: entry.oid, source: doc.source },
      original,
    });
  }, [review.data, entry, past, rendered, doc.source, firstPlacements, original]);
  const unresolved = useMemo(() => new Map(Object.entries(review.data?.unresolvedByPath ?? {})), [review.data]);
  const [filters, setFilters] = useState<ReadonlySet<ThreadState>>(DEFAULT_FILTERS);

  const navigate = Route.useNavigate();
  const setActive = (threadId: string | null) => {
    const root = threads?.find((t) => t.id === threadId)?.comments[0];
    void navigate({ search: (s) => ({ ...s, thread: root?.id }), replace: true });
  };
  const wordRanges = useAnchors(article, rendered, doc.source, placements, filters, active?.id ?? null, setActive);

  // A new document starts at its top, unless a thread link targets it: focusing the thread scrolls there.
  const scrollTop = useEffectEvent(() => {
    if (!search.thread) document.querySelector(".rr-scroll")?.scrollTo(0, 0);
  });
  useEffect(() => scrollTop(), [path, search.rev]);
  useLineTarget(article, doc.rendered);

  const { state } = prState(pr);
  // Guests reading GitHub directly (not through the token-backed proxy) get the sign-in suggestion.
  const viewer = useQuery(viewerQuery).data;
  const reviewMode = useReviewMode({ pr, id, files, entry, doc: current, viewer });
  usePendingHighlight(
    article,
    view === "rendered" && !historical ? doc.rendered : undefined,
    doc.source,
    reviewMode.highlighted,
  );
  const proxied = useQuery(allowedHostsQuery).data?.proxyFirst.includes(id.host);
  const guest = viewer?.signInEnabled && !viewer.signedIn && proxied === false;
  const link = entry && { ...id, sha: doc.sha, path: past?.path ?? entry.path };
  const router = useRouter();
  const onInAppLink = useInAppLinks();
  // "View in original": this document at the commit the thread was written on, focused on it.
  const originalLink = (thread: NativeThread, commitOid: string) => ({
    href: router.buildLocation({
      from: Route.fullPath,
      to: ".",
      search: (s) => ({ ...s, doc: entry?.path, rev: commitOid, thread: thread.comments[0]!.id }),
    }).href,
    onClick: onInAppLink,
  });
  const revisions =
    entry &&
    threads &&
    revisionOptions({
      entry,
      current: current.sha,
      base: id.baseSha,
      threads,
      commits: commits.data ?? [],
      selected: historical ? search.rev : undefined,
    });
  const commit = historical ? commits.data?.find((c) => c.oid === search.rev) : undefined;

  return (
    <AppShell
      title={<PrTitle pr={pr} id={id} docCount={changed.length} />}
      actions={
        <>
          <ExternalLink className="rr-btn rr-btn-ghost" href={pr.htmlUrl}>
            Open in GitHub
          </ExternalLink>
          {reviewMode.reviewButton}
        </>
      }
      sidebar={
        <Sidebar
          mode={search.files}
          changed={changed}
          all={all}
          truncated={tree.data?.truncated}
          allError={!!tree.error}
          selected={path}
          unresolved={unresolved}
          resolutionKnown={review.data?.threads.every((t) => t.resolution !== "unknown")}
          otherCount={otherCount}
          filesUrl={`${pr.htmlUrl}/files`}
          pr={{
            number: pr.number,
            state,
            selected: overview,
            comments: review.data?.timeline.length,
            reviewers: review.raw && reviewers(review.raw, pr.author?.login),
          }}
        />
      }
      toolbar={
        overview ? (
          <>
            <OverviewCrumbs id={id} state={state} />
            <ExternalLink className="rr-btn rr-btn-sm rr-btn-ghost" href={pr.htmlUrl}>
              Open in GitHub
            </ExternalLink>
          </>
        ) : (
          entry && (
            <>
              <div className="rr-seg" role="group" aria-label="View">
                <button type="button" aria-pressed={view === "rendered"} onClick={() => setView("rendered")}>
                  Rendered
                </button>
                <button type="button" aria-pressed={view === "raw"} onClick={() => setView("raw")}>
                  Raw
                </button>
              </div>
              {revisions && revisions.length > 1 ? (
                <select
                  className="rr-btn rr-btn-sm rr-rev-select"
                  aria-label="Revision"
                  value={historical ? search.rev : current.sha}
                  onChange={(e) => {
                    const rev = e.target.value === current.sha ? undefined : e.target.value;
                    void navigate({ search: (s) => ({ ...s, rev }) });
                  }}
                >
                  {revisions.map((r) => (
                    <option key={r.oid} value={r.oid}>
                      {r.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="rr-seg">
                  <span className="rr-seg-static">
                    <span className="rr-sr-only">Revision: </span>
                    {entry.status === "deleted" ? "Base" : "Current"} · <code>{doc.sha.slice(0, 7)}</code>
                  </span>
                </span>
              )}
              <DocumentCrumbs id={id} path={entry.path} />
              {doc.changes.length > 0 && (
                <span className="rr-legend" role="note" aria-label="Changed-section legend">
                  <span>
                    <i className="rr-legend-added" />
                    Added
                  </span>
                  <span>
                    <i className="rr-legend-modified" />
                    Modified
                  </span>
                </span>
              )}
            </>
          )
        )
      }
      toolbarEnd={
        link && (
          <ExternalLink className="rr-btn rr-btn-sm rr-btn-ghost" href={sourceUrl(link, link.sha, link.path)}>
            Source
          </ExternalLink>
        )
      }
      commentCount={review.data && entry ? placements.length : undefined}
      railTitle={
        overview ? (
          <>
            Documents with comments
            {review.data && <span className="rr-count">{docsWithComments(review.data.threads)}</span>}
          </>
        ) : undefined
      }
      railHeader={
        review.data &&
        entry && (
          <>
            <RailHeader counts={placementCounts(placements)} filters={filters} onFiltersChange={setFilters} />
            {historical && (
              <p className="rr-conv-note">
                Comments written on <code>{search.rev!.slice(0, 7)}</code>. The others are on the current revision.
              </p>
            )}
            <p className="rr-conv-note">
              PR conversation ({review.data.timeline.length}) is in{" "}
              <Link
                from={Route.fullPath}
                search={(s) => ({ ...s, view: "overview" as const, doc: undefined, thread: undefined })}
              >
                Overview
              </Link>
              .
            </p>
          </>
        )
      }
      rail={
        review.error ? (
          <p className="rr-rail-empty">Could not load comments: {review.error.message}</p>
        ) : !review.data || (entry && doc.source === undefined && !doc.error) ? (
          // Wait for the document too: cards placed before it renders would move (and lose focus) once it does.
          <p className="rr-rail-empty">Loading comments…</p>
        ) : overview ? (
          <DocsWithComments threads={review.data.threads} docs={changed} />
        ) : (
          entry && (
            <>
              {reviewMode.status}
              <CommentRail
                placements={placements}
                repository={repository}
                filters={filters}
                docContainerRef={docColumn}
                wordRanges={wordRanges}
                activeThreadId={active?.id ?? null}
                onActiveThreadChange={setActive}
                extras={historical ? undefined : reviewMode.extras}
                threadActions={reviewMode.threadActions}
                originalLink={originalLink}
              />
              {!historical && reviewMode.unplacedDrafts}
            </>
          )
        )
      }
    >
      <RateLimitBanner />
      {guest && <GuestNotice host={id.host} />}
      {overview ? (
        <PrOverview
          pr={pr}
          id={id}
          timeline={review.data?.timeline}
          timelineError={review.error}
          focusCommentId={threadIsComment ? search.thread : undefined}
        />
      ) : !entry ? (
        tree.isPending && !tree.error ? (
          <DocMessage title="Loading…" />
        ) : (
          <DocMessage title="Document not found">
            <code>{path}</code> is not a Markdown document in this pull request.
          </DocMessage>
        )
      ) : doc.error ? (
        <DocMessage title="Could not load this document">{doc.error.message}</DocMessage>
      ) : doc.source === undefined || !link ? (
        <DocMessage title="Loading document…" />
      ) : (
        <>
          {historical && (
            <p className="rr-doc-note rr-history-banner" role="status" aria-label="Historical revision">
              <span className="rr-badge rr-b-neutral">Original</span> Viewing{" "}
              <ExternalLink href={`https://${id.host}/${id.owner}/${id.repo}/commit/${search.rev}`}>
                <code>{search.rev!.slice(0, 7)}</code>
              </ExternalLink>
              {commit && (
                <>
                  {" "}
                  from{" "}
                  <time dateTime={commit.committedAt} title={new Date(commit.committedAt).toLocaleString()}>
                    {new Date(commit.committedAt).toLocaleDateString()} ({relativeTime(commit.committedAt)})
                  </time>
                </>
              )}
              , read-only. Comments can only be added to the current revision.{" "}
              <Link from={Route.fullPath} search={(s) => ({ ...s, rev: undefined })}>
                Back to current
              </Link>
            </p>
          )}
          {entry.status === "deleted" && !historical && (
            <p className="rr-doc-note">
              Deleted in this pull request. Showing the base revision (<code>{doc.sha.slice(0, 7)}</code>), read-only.
            </p>
          )}
          {view === "raw" || doc.renderError ? (
            <>
              {view !== "raw" && (
                <p className="rr-doc-note">
                  Could not render this document, showing its source. {doc.renderError?.message}
                </p>
              )}
              <RawDocument source={doc.source} changes={doc.changes} link={link} />
            </>
          ) : doc.rendered ? (
            <>
              <RenderedDocument
                rendered={doc.rendered}
                changes={doc.changes}
                link={link}
                blobOid={past?.key ?? entry.oid}
                containerRef={setArticle}
              />
              {!historical && (
                <SelectionPopover
                  article={article}
                  rendered={doc.rendered}
                  source={doc.source}
                  onCompose={(selection, suggest) => reviewMode.compose(entry.path, selection, suggest)}
                />
              )}
            </>
          ) : doc.rendering ? (
            <DocMessage title="Rendering large document…" />
          ) : (
            <DocMessage title="This document is too large to render">
              It has {doc.source.length.toLocaleString()} characters; the limit is {MAX_RENDER_CHARS.toLocaleString()}.{" "}
              <button type="button" className="rr-btn rr-btn-sm" onClick={() => setView("raw")}>
                View raw
              </button>{" "}
              <ExternalLink className="rr-btn rr-btn-sm rr-btn-ghost" href={sourceUrl(link, link.sha, link.path)}>
                Open on GitHub
              </ExternalLink>
            </DocMessage>
          )}
        </>
      )}
    </AppShell>
  );
}

/**
 * Whether the original blobs of annotations that could not be placed can still be read, fetched
 * only for those (by OID, so each is read once and cached): an unplaced comment is then either
 * historical-only (its original can be opened) or unavailable.
 */
function useOriginals(id: PrIdentity, placements: ThreadPlacement[]): ReadonlyMap<string, "available" | "missing"> {
  const oids = [
    ...new Set(
      placements.flatMap((p) =>
        p.reanchor?.state === "outdated" && p.thread.anchor.type === "annotation"
          ? [p.thread.anchor.annotation.target.blobOid]
          : [],
      ),
    ),
  ];
  const states = useQueries({
    queries: oids.map((oid) => blobQuery(id, oid)),
    // A plain object, so it stays the same object while nothing changes.
    combine: (results) => {
      const known: Record<string, "available" | "missing"> = {};
      results.forEach((r, i) => {
        if (r.isSuccess) known[oids[i]!] = "available";
        else if (r.error instanceof NotFoundError) known[oids[i]!] = "missing";
      });
      return known;
    },
  });
  return useMemo(() => new Map(Object.entries(states)), [states]);
}

/**
 * GitHub-native review content for the PR. Thread resolution needs GraphQL, which GitHub refuses
 * anonymously: known when signed in, unknown otherwise (or when that read fails).
 */
function useReview(id: PrIdentity) {
  const comments = useQuery(reviewCommentsQuery(id));
  const reviews = useQuery(reviewsQuery(id));
  const issueComments = useQuery(issueCommentsQuery(id));
  const threads = useQuery(reviewThreadsQuery(id));
  const threadsSettled = id.access !== "user" || !threads.isPending;
  const data = useMemo(
    () =>
      comments.data && reviews.data && issueComments.data && threadsSettled
        ? projectReview({
            repository: {
              host: id.host,
              owner: id.owner,
              name: id.repo,
              repositoryId: id.repositoryId,
              pullRequest: id.number,
            },
            reviewComments: comments.data,
            reviewThreads: threads.data,
            reviews: reviews.data,
            issueComments: issueComments.data,
          })
        : undefined,
    [id, comments.data, reviews.data, issueComments.data, threads.data, threadsSettled],
  );
  return { data, raw: reviews.data, error: comments.error ?? reviews.error ?? issueComments.error };
}

/**
 * A `#L12` or `#L12-L20` hash (a Jump link from the conversation) scrolls to the first rendered
 * block of those lines, focuses it and flashes it.
 */
function useLineTarget(article: HTMLElement | null, rendered: RenderedMarkdown | undefined) {
  const hash = useLocation({ select: (l) => l.hash });
  useEffect(() => {
    const m = /^#?L(\d+)(?:-L(\d+))?$/.exec(hash);
    if (!article || !rendered || !m) return;
    const start = Number(m[1]);
    const block = blocksForLines(rendered, start, Number(m[2] ?? start))[0];
    const el = block && nodeElement(article, block.id);
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
    el.dataset.rrFlash = "";
    const done = () => {
      delete el.dataset.rrFlash;
    };
    el.addEventListener("animationend", done, { once: true });
    return done;
  }, [article, rendered, hash]);
}

function PrTitle({ pr, id, docCount }: { pr: PullRequest; id: PrIdentity; docCount: number }) {
  const { state, label } = prState(pr);
  const verb = pr.merged ? "merged into" : pr.state === "open" ? "wants to merge into" : "proposed merging into";
  return (
    <>
      <h1 className="rr-pr-title" title={pr.title}>
        {pr.title} <span className="rr-pr-num">#{pr.number}</span>
      </h1>
      <div className="rr-pr-meta">
        <span className={`rr-badge rr-badge-${state}`}>{label}</span>
        <span>
          {id.owner}/{id.repo}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {pr.author && <b>{pr.author.login}</b>} {verb} <code>{pr.base.ref}</code>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {docCount} {docCount === 1 ? "doc" : "docs"} changed
        </span>
      </div>
    </>
  );
}

function DocMessage({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rr-doc-message" role="status">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

/** Non-blocking notice while GitHub's rate limit holds and the page shows cached data. */
function RateLimitBanner() {
  const resetAt = useSyncExternalStore(rateLimit.subscribe, rateLimit.resetAt, () => undefined);
  if (!resetAt || resetAt.getTime() <= Date.now()) return null;
  return (
    <p className="rr-doc-note" role="status">
      GitHub rate limit reached — showing cached data; retry after{" "}
      {resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
    </p>
  );
}

function SignInButton() {
  return (
    <button type="button" className="rr-btn" onClick={() => void signIn()}>
      Sign in with GitHub
    </button>
  );
}

function ErrorState({ error, offerSignIn }: { error: Error; offerSignIn?: boolean }) {
  if (isSignInRequired(error)) {
    return (
      <Message title="Sign in again" action={<SignInButton />}>
        Your GitHub sign-in has expired or was revoked.
      </Message>
    );
  }
  // Seam for private repository support: needs the GitHub App installed and a plan that covers it.
  if (isPrivateRepoUnsupported(error)) {
    return (
      <Message title="Private repositories aren't supported yet">
        Rendered Review can only show pull requests in public repositories for now.
      </Message>
    );
  }
  // Signed in, the viewer's own 5,000/hour limit replaces the shared anonymous one.
  const action = offerSignIn ? <SignInButton /> : undefined;
  if (error instanceof RateLimitError) {
    return (
      <Message title="GitHub rate limit reached" action={action}>
        Try again after {error.resetAt.toLocaleTimeString()}.
      </Message>
    );
  }
  // Anonymous requests cannot tell a private repository from a missing one: GitHub answers 404.
  if (error instanceof NotFoundError || error instanceof ForbiddenError) {
    return (
      <Message title="Pull request unavailable" action={action}>
        This pull request does not exist or is in a private repository. Sign-in for private repositories is coming
        later.
      </Message>
    );
  }
  return <Message title="Something went wrong">{error.message}</Message>;
}

/** Whole-page state (loading, errors, not found), inside the app shell so home stays one click away. */
function Message({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <AppShell>
      <div className="rr-message">
        <h1>{title}</h1>
        {children && <p>{children}</p>}
        {action}
      </div>
    </AppShell>
  );
}
