// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { parsePullRequestUrl } from "../pr-url";
import { wait } from "../review/publish";
import { OFFLINE_HEADER, OFFLINE_SHELL } from "../sw/policy";
import { AppShell } from "../ui/AppShell";

export const Route = createFileRoute("/")({
  // Public, user-independent page: the service worker may keep it for offline use.
  headers: () => ({ [OFFLINE_HEADER]: OFFLINE_SHELL }),
  // Where the sign-in callback sends a browser it refused for too many attempts.
  validateSearch: (search: Record<string, unknown>): { error?: string; retry_after?: number } => ({
    ...(typeof search.error === "string" && { error: search.error }),
    ...(Number.isSafeInteger(Number(search.retry_after)) &&
      Number(search.retry_after) > 0 && { retry_after: Number(search.retry_after) }),
  }),
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const [invalid, setInvalid] = useState(false);
  const search = Route.useSearch();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = parsePullRequestUrl(String(new FormData(event.currentTarget).get("url")));
    setInvalid(!params);
    if (params) void navigate({ to: "/$host/$owner/$repo/pull/$number", params });
  }

  return (
    <AppShell title={<strong>Review Markdown pull requests as rendered documents</strong>}>
      <h1>Rendered Review</h1>
      {search.error === "too_many_requests" && (
        <p role="alert">
          Too many sign-in attempts. Try again {search.retry_after ? wait(search.retry_after) : "in a minute"}.
        </p>
      )}
      <form onSubmit={onSubmit}>
        <label htmlFor="pr-url">GitHub pull request URL</label>{" "}
        <input
          id="pr-url"
          name="url"
          inputMode="url"
          required
          placeholder="https://github.com/owner/repo/pull/123"
          aria-invalid={invalid}
          aria-describedby={invalid ? "pr-url-error" : undefined}
        />{" "}
        <button type="submit" className="rr-btn rr-btn-primary">
          Open
        </button>
        {invalid && <p id="pr-url-error">That is not a GitHub pull request URL.</p>}
      </form>
    </AppShell>
  );
}
