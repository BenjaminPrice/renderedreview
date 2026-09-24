// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { parsePullRequestUrl } from "../pr-url";
import { OFFLINE_HEADER, OFFLINE_SHELL } from "../sw/policy";
import { AppShell, Icon, useShell } from "../ui/AppShell";

export const Route = createFileRoute("/")({
  // Public, user-independent page: the service worker may keep it for offline use.
  headers: () => ({ [OFFLINE_HEADER]: OFFLINE_SHELL }),
  component: Home,
});

const muted = { padding: "12px 16px", margin: 0, color: "var(--rr-text-muted)" };

function Home() {
  const navigate = useNavigate();
  const [invalid, setInvalid] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = parsePullRequestUrl(String(new FormData(event.currentTarget).get("url")));
    setInvalid(!params);
    if (params) void navigate({ to: "/$host/$owner/$repo/pull/$number", params });
  }

  // The shell's regions hold placeholder content until the review views fill them.
  return (
    <AppShell
      title={<strong>Review Markdown pull requests as rendered documents</strong>}
      sidebar={<p style={muted}>Changed documents appear here.</p>}
      toolbar={<span style={{ color: "var(--rr-text-muted)", fontSize: "var(--rr-text-sm)" }}>Rendered view</span>}
      commentCount={0}
      rail={<p style={muted}>Review threads appear here.</p>}
    >
      <h1>Rendered Review</h1>
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
      <DemoMarker />
    </AppShell>
  );
}

// Margin marker in the document gutter, shown while the rail is not pinned.
function DemoMarker() {
  const { railMode, openRail } = useShell();
  if (railMode === "pinned") return null;
  return (
    <button
      type="button"
      className="rr-btn rr-btn-sm"
      style={{ position: "absolute", right: 10, top: 120, borderRadius: 999 }}
      aria-label="Open comment rail"
      aria-controls="rr-rail"
      onClick={openRail}
    >
      <Icon name="comment" />
    </button>
  );
}
