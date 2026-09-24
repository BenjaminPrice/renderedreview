// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ChangedFile,
  ForbiddenError,
  NotFoundError,
  type PullRequest,
  RateLimitError,
} from "@rendered-review/github-integration";
import { placeThreads, projectReview, type ThreadPlacement } from "@rendered-review/review-domain";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, stripSearchParams } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  MAX_RENDER_CHARS,
  nodeElement,
  RawDocument,
  RenderedDocument,
  useDocument,
} from "../document/document";
import { allDocs, changedDocs, selectedPath, sourceUrl } from "../document/docs";
import { Sidebar } from "../document/Sidebar";
import { ExternalLink } from "../ui/ExternalLink";
import { preferProxy } from "../github/client";
import { allowedHosts, proxyFirstHosts } from "../github/proxy";
import {
  changedFilesQuery,
  issueCommentsQuery,
  type PrIdentity,
  prIdentity,
  pullRequestQuery,
  reviewCommentsQuery,
  reviewsQuery,
  treeQuery,
} from "../github/queries";
import {
  CommentRail,
  ConversationPanel,
  DEFAULT_FILTERS,
  filterCounts,
  RailHeader,
  ReviewSummaries,
  threadDomId,
  threadState,
  type ThreadState,
} from "../review";
import { AppShell } from "../ui/AppShell";
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
  const pr = useQuery(pullRequestQuery(params));
  const identity = pr.data && prIdentity(params.host, pr.data);
  // Placeholder identity while the PR loads; the query stays disabled until the real one exists.
  const files = useQuery({ ...changedFilesQuery(identity ?? ({} as PrIdentity)), enabled: !!identity });

  const error = pr.error ?? files.error;
  if (error) return <ErrorState error={error} />;
  if (!pr.data || !identity || !files.data) return <Message title="Loading…" />;
  return <ReviewPage pr={pr.data} id={identity} files={files.data} />;
}

function ReviewPage({ pr, id, files }: { pr: PullRequest; id: PrIdentity; files: ChangedFile[] }) {
  const search = Route.useSearch();
  const { docs: changed, otherCount } = useMemo(() => changedDocs(files), [files]);
  const path = selectedPath(search.doc, changed);
  const changedEntry = changed.find((d) => d.path === path);
  const tree = useQuery({
    ...treeQuery(id, id.headSha),
    enabled: search.files === "all" || (path !== undefined && !changedEntry),
  });
  const all = useMemo(() => tree.data && allDocs(tree.data, changed), [tree.data, changed]);
  const entry = changedEntry ?? all?.find((d) => d.path === path);
  const doc = useDocument(id, entry);
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  // The rendered article, as state so the rail and anchors follow it across loads and view switches.
  const [article, setArticle] = useState<HTMLElement | null>(null);
  // The rail draws markers and connectors in the positioned document column around it.
  const docColumn = useMemo(() => ({ current: article?.parentElement ?? null }), [article]);

  const review = useReview(id);
  const repository = useMemo(() => ({ host: id.host, owner: id.owner, name: id.repo }), [id]);
  const placements = useMemo(() => {
    if (!review.data || !entry) return [];
    const rendered = view === "rendered" ? doc.rendered : undefined;
    // Deleted docs show the base revision, so only LEFT-side (base) lines can be placed.
    return placeThreads(
      review.data.threads,
      entry.path,
      entry.status === "deleted" ? { base: rendered } : { head: rendered },
    );
  }, [review.data, entry, view, doc.rendered]);
  const unresolved = useMemo(() => new Map(Object.entries(review.data?.unresolvedByPath ?? {})), [review.data]);
  const [filters, setFilters] = useState<ReadonlySet<ThreadState>>(DEFAULT_FILTERS);

  // The active thread lives in the URL (`thread`: root comment id) so it can be shared.
  const navigate = Route.useNavigate();
  const threads = review.data?.threads;
  const active = threads?.find((t) => t.id === search.thread || t.comments.some((c) => c.id === search.thread));
  const setActive = (threadId: string | null) => {
    const root = threads?.find((t) => t.id === threadId)?.comments[0];
    void navigate({ search: (s) => ({ ...s, thread: root?.id }), replace: true });
  };
  useAnchors(article, placements, filters, active?.id ?? null, setActive);

  const dir = entry ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "";
  const link = entry && { ...id, sha: doc.sha, path: entry.path };

  return (
    <AppShell
      title={<PrTitle pr={pr} id={id} docCount={changed.length} />}
      actions={
        <ExternalLink className="rr-btn rr-btn-ghost" href={pr.htmlUrl}>
          Open in GitHub
        </ExternalLink>
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
          otherCount={otherCount}
          filesUrl={`${pr.htmlUrl}/files`}
        />
      }
      toolbar={
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
            <span className="rr-seg">
              <span className="rr-seg-static">
                <span className="rr-sr-only">Revision: </span>
                {entry.status === "deleted" ? "Base" : "Current"} · <code>{doc.sha.slice(0, 7)}</code>
              </span>
            </span>
            <span className="rr-doc-path" title={entry.path}>
              <span className="rr-sr-only">File: </span>
              {dir}
              <b>{entry.path.slice(dir.length)}</b>
            </span>
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
      }
      toolbarEnd={
        link && (
          <ExternalLink className="rr-btn rr-btn-sm rr-btn-ghost" href={sourceUrl(link, link.sha, link.path)}>
            Source
          </ExternalLink>
        )
      }
      commentCount={review.data && entry ? placements.length : undefined}
      railHeader={
        review.data &&
        entry && (
          <RailHeader
            counts={filterCounts(placements.map((p) => p.thread))}
            filters={filters}
            onFiltersChange={setFilters}
          />
        )
      }
      rail={
        review.error ? (
          <p className="rr-rail-empty">Could not load comments: {review.error.message}</p>
        ) : !review.data ? (
          <p className="rr-rail-empty">Loading comments…</p>
        ) : (
          <>
            {entry && (
              <CommentRail
                placements={placements}
                repository={repository}
                filters={filters}
                docContainerRef={docColumn}
                activeThreadId={active?.id ?? null}
                onActiveThreadChange={setActive}
              />
            )}
            {/* Pull-request-level content has no anchor in a document; it follows the document's threads. */}
            <div className="rr-rail-group">
              <ReviewSummaries reviews={review.data.summaries} />
              <ConversationPanel entries={review.data.conversation} repository={repository} />
            </div>
          </>
        )
      }
    >
      {!path ? (
        <DocMessage title="No Markdown changed in this pull request">
          Browse the repository&apos;s documents under All docs, or{" "}
          <ExternalLink href={`${pr.htmlUrl}/files`}>review the changes on GitHub</ExternalLink>.
        </DocMessage>
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
          {entry.status === "deleted" && (
            <p className="rr-doc-note">
              Deleted in this pull request. Showing the base revision (<code>{doc.sha.slice(0, 7)}</code>), read-only.
            </p>
          )}
          {view === "raw" ? (
            <RawDocument source={doc.source} changes={doc.changes} link={link} />
          ) : doc.rendered ? (
            <RenderedDocument rendered={doc.rendered} changes={doc.changes} containerRef={setArticle} />
          ) : (
            <DocMessage title="This document is too large to render">
              It has {doc.source.length.toLocaleString()} characters; the limit is {MAX_RENDER_CHARS.toLocaleString()}.{" "}
              <button type="button" className="rr-btn rr-btn-sm" onClick={() => setView("raw")}>
                View raw
              </button>
            </DocMessage>
          )}
        </>
      )}
    </AppShell>
  );
}

/**
 * GitHub-native review content for the PR. Thread resolution needs GraphQL, which GitHub refuses
 * anonymously, so it stays unknown until signed-in access exists.
 */
function useReview(id: PrIdentity) {
  const comments = useQuery(reviewCommentsQuery(id));
  const reviews = useQuery(reviewsQuery(id));
  const issueComments = useQuery(issueCommentsQuery(id));
  const data = useMemo(
    () =>
      comments.data && reviews.data && issueComments.data
        ? projectReview({
            repository: { host: id.host, owner: id.owner, name: id.repo },
            reviewComments: comments.data,
            reviews: reviews.data,
            issueComments: issueComments.data,
          })
        : undefined,
    [id, comments.data, reviews.data, issueComments.data],
  );
  return { data, error: comments.error ?? reviews.error ?? issueComments.error };
}

/**
 * Marks the rendered blocks of visible threads: `aria-details` points at their cards, and
 * `data-rr-anchor` / `data-rr-active` drive the highlight. Clicking a block, or Enter/Space on it,
 * activates its thread. Attributes are set on React-rendered elements, so they are removed again
 * before every update.
 */
function useAnchors(
  article: HTMLElement | null,
  placements: ThreadPlacement[],
  filters: ReadonlySet<ThreadState>,
  activeId: string | null,
  activate: (threadId: string) => void,
) {
  const onActivate = useEffectEvent(activate);
  useEffect(() => {
    if (!article) return;
    const threadsOf = new Map<HTMLElement, ThreadPlacement["thread"][]>();
    for (const { thread, blocks } of placements) {
      if (!filters.has(threadState(thread))) continue;
      for (const block of blocks) {
        const el = nodeElement(article, block.id);
        if (el) threadsOf.set(el, [...(threadsOf.get(el) ?? []), thread]);
      }
    }
    for (const [el, threads] of threadsOf) {
      el.setAttribute("aria-details", threads.map((t) => threadDomId(t.id)).join(" "));
      el.dataset.rrAnchor = threadState(threads[0]!);
      if (threads.some((t) => t.id === activeId)) el.dataset.rrActive = "";
      el.tabIndex = 0;
    }
    const handle = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const anchor = target.closest<HTMLElement>("[data-rr-anchor]");
      const threads = anchor && threadsOf.get(anchor);
      if (!threads) return;
      if (event instanceof KeyboardEvent) {
        if (target !== anchor || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
      } else if (target.closest("a, button, summary, input")) return; // links inside keep working
      onActivate(threads[0]!.id);
    };
    article.addEventListener("click", handle);
    article.addEventListener("keydown", handle);
    return () => {
      article.removeEventListener("click", handle);
      article.removeEventListener("keydown", handle);
      for (const el of threadsOf.keys()) {
        el.removeAttribute("aria-details");
        el.removeAttribute("data-rr-anchor");
        el.removeAttribute("data-rr-active");
        el.removeAttribute("tabindex");
      }
    };
  }, [article, placements, filters, activeId]);
}

function PrTitle({ pr, id, docCount }: { pr: PullRequest; id: PrIdentity; docCount: number }) {
  const [state, label] = pr.merged
    ? ["merged", "Merged"]
    : pr.state === "closed"
      ? ["closed", "Closed"]
      : pr.draft
        ? ["draft", "Draft"]
        : ["open", "Open"];
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

function ErrorState({ error }: { error: Error }) {
  if (error instanceof RateLimitError) {
    return <Message title="GitHub rate limit reached">Try again after {error.resetAt.toLocaleTimeString()}.</Message>;
  }
  // Anonymous requests cannot tell a private repository from a missing one: GitHub answers 404.
  if (error instanceof NotFoundError || error instanceof ForbiddenError) {
    return (
      <Message title="Pull request unavailable">
        This pull request does not exist or is in a private repository. Sign-in for private repositories is coming
        later.
      </Message>
    );
  }
  return <Message title="Something went wrong">{error.message}</Message>;
}

function Message({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main className="rr-message">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </main>
  );
}
