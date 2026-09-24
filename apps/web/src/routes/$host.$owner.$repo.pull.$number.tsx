// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ChangedFile,
  ForbiddenError,
  NotFoundError,
  type PullRequest,
  RateLimitError,
} from "@rendered-review/github-integration";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, stripSearchParams } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo, useRef, useState } from "react";
import { ExternalIcon, MAX_RENDER_CHARS, RawDocument, RenderedDocument, useDocument } from "../document/document";
import { allDocs, changedDocs, selectedPath, sourceUrl } from "../document/docs";
import { Sidebar } from "../document/Sidebar";
import { allowedHosts } from "../github/proxy";
import { changedFilesQuery, type PrIdentity, prIdentity, pullRequestQuery, treeQuery } from "../github/queries";
import { AppShell } from "../ui/AppShell";
import { parsePrParams, validatePrSearch } from "../pr-url";

const getAllowedHosts = createServerFn({ method: "GET" }).handler(({ context }) => allowedHosts(context.config));

/** Deployment config; fetched once per session. */
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
    const hosts = await context.queryClient.ensureQueryData(allowedHostsQuery);
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
  // The rendered article; the comment rail positions threads against it.
  const docRef = useRef<HTMLElement>(null);

  const dir = entry ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "";
  const link = entry && { ...id, sha: doc.sha, path: entry.path };

  return (
    <AppShell
      title={<PrTitle pr={pr} id={id} docCount={changed.length} />}
      actions={
        <a className="rr-btn rr-btn-ghost" href={pr.htmlUrl}>
          Open in GitHub
          <ExternalIcon />
        </a>
      }
      sidebar={
        <Sidebar
          mode={search.files}
          changed={changed}
          all={all}
          truncated={tree.data?.truncated}
          allError={!!tree.error}
          selected={path}
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
          <a className="rr-btn rr-btn-sm rr-btn-ghost" href={sourceUrl(link, link.sha, link.path)}>
            Source
            <ExternalIcon />
          </a>
        )
      }
      railHeader={null}
      rail={<p className="rr-rail-empty">Comments on this document will appear here.</p>}
    >
      {!path ? (
        <DocMessage title="No Markdown changed in this pull request">
          Browse the repository&apos;s documents under All docs, or{" "}
          <a href={`${pr.htmlUrl}/files`}>review the changes on GitHub</a>.
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
            <RenderedDocument rendered={doc.rendered} changes={doc.changes} containerRef={docRef} />
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
