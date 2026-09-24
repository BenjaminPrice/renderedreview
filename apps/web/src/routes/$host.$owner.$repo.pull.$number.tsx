// SPDX-License-Identifier: AGPL-3.0-only
import { ForbiddenError, NotFoundError, RateLimitError } from "@rendered-review/github-integration";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, stripSearchParams } from "@tanstack/react-router";
import { changedFilesQuery, prIdentity, pullRequestQuery } from "../github/queries";
import { isMarkdownPath, parsePrParams, validatePrSearch } from "../pr-url";

export const Route = createFileRoute("/$host/$owner/$repo/pull/$number")({
  params: {
    parse: (raw) => {
      const params = parsePrParams(raw);
      if (!params) throw notFound();
      return params;
    },
    stringify: (params) => ({ ...params, number: String(params.number) }),
  },
  validateSearch: validatePrSearch,
  // Keep shared links clean: the default sidebar mode is implied.
  search: { middlewares: [stripSearchParams({ files: "changed" })] },
  head: ({ params }) => ({ meta: [{ title: `${params.owner}/${params.repo}#${params.number} · Rendered Review` }] }),
  component: PullRequestPage,
  notFoundComponent: () => <Message title="Not found">This is not a valid pull request link.</Message>,
});

function PullRequestPage() {
  const params = Route.useParams();
  const pr = useQuery(pullRequestQuery(params));
  const identity = pr.data && prIdentity(params.host, pr.data);
  const files = useQuery({ ...changedFilesQuery(identity!), enabled: !!identity });

  const error = pr.error ?? files.error;
  if (error) return <ErrorState error={error} />;
  if (!pr.data || !files.data) return <Message title="Loading…" />;

  const markdown = files.data.filter((f) => isMarkdownPath(f.path));
  return (
    <main>
      <h1>{pr.data.title}</h1>
      <p>
        <a href={pr.data.htmlUrl}>View on GitHub</a>
      </p>
      {markdown.length === 0 ? (
        <p>No Markdown in this PR.</p>
      ) : (
        <ul>
          {markdown.map((f) => (
            <li key={f.path}>{f.path}</li>
          ))}
        </ul>
      )}
    </main>
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
    <main>
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </main>
  );
}
