// SPDX-License-Identifier: AGPL-3.0-only
// Top-bar account slot. Fetched in the browser after load, so server-rendered (and offline-cached)
// pages never carry who is signed in. Hidden when this deployment has no GitHub sign-in.
import { useEffect, useState } from "react";

type Viewer = { login: string; avatarUrl: string | null; publicComments?: "linked" | "unlinked" };

const post = (path: string, body: object) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function startOAuth(path: string, provider: string, navigate: (url: string) => void) {
  const response = await post(path, { provider, callbackURL: location.pathname + location.search + location.hash });
  const { url } = (await response.json()) as { url?: string };
  if (url) navigate(url);
}

/** Starts GitHub sign-in, returning to the whole current URL (fragment included): same document and thread. */
export const signIn = (navigate = (url: string) => location.assign(url)) =>
  startOAuth("/api/auth/sign-in/social", "github", navigate);

/**
 * Links the OAuth App that comments on public repositories without the GitHub App installed
 * (`public_repo` scope), returning to the whole current URL. For the composer when publishing
 * answers `needs-public-authorization`.
 */
export const authorizePublicComments = (navigate = (url: string) => location.assign(url)) =>
  startOAuth("/api/auth/link-social", "github-public", navigate);

export function ViewerSlot({ navigate = (url: string) => location.assign(url) }: { navigate?: (url: string) => void }) {
  // undefined: loading or sign-in unavailable; null: signed out.
  const [viewer, setViewer] = useState<Viewer | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/auth/viewer", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<Viewer | null>) : undefined))
      .then(setViewer, () => setViewer(undefined));
  }, []);

  async function signOut() {
    if (!(await post("/api/auth/sign-out", {})).ok) return;
    setViewer(null);
    // Reload, dropping everything read with the user's access (queries and the in-memory cache).
    navigate(location.href);
  }

  if (viewer === undefined) return null;
  if (viewer === null) {
    return (
      <button type="button" className="rr-btn" onClick={() => signIn(navigate)}>
        Sign in with GitHub
      </button>
    );
  }
  return (
    <span className="rr-viewer">
      {viewer.avatarUrl && <img className="rr-avatar" src={viewer.avatarUrl} alt="" width={28} height={28} />}
      <span className="rr-sr-only">Signed in as </span>
      <span className="rr-viewer-login">{viewer.login}</span>
      {viewer.publicComments === "unlinked" && (
        <button
          type="button"
          className="rr-btn rr-btn-ghost rr-btn-sm"
          onClick={() => authorizePublicComments(navigate)}
        >
          Allow commenting on public repositories
        </button>
      )}
      <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}
