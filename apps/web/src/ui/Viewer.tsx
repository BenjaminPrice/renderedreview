// SPDX-License-Identifier: AGPL-3.0-only
// Top-bar account slot. Fetched in the browser after load, so server-rendered (and offline-cached)
// pages never carry who is signed in. Hidden when this deployment has no GitHub sign-in.
import { useEffect, useState } from "react";

type Viewer = { login: string; avatarUrl: string | null };

const post = (path: string, body: object) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function ViewerSlot({ navigate = (url: string) => location.assign(url) }: { navigate?: (url: string) => void }) {
  // undefined: loading or sign-in unavailable; null: signed out.
  const [viewer, setViewer] = useState<Viewer | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/auth/viewer", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<Viewer | null>) : undefined))
      .then(setViewer, () => setViewer(undefined));
  }, []);

  async function signIn() {
    // The whole current URL, fragment included, so sign-in lands back on the same document and thread.
    const response = await post("/api/auth/sign-in/social", {
      provider: "github",
      callbackURL: location.pathname + location.search + location.hash,
    });
    const { url } = (await response.json()) as { url?: string };
    if (url) navigate(url);
  }

  async function signOut() {
    if ((await post("/api/auth/sign-out", {})).ok) setViewer(null);
  }

  if (viewer === undefined) return null;
  if (viewer === null) {
    return (
      <button type="button" className="rr-btn" onClick={signIn}>
        Sign in with GitHub
      </button>
    );
  }
  return (
    <span className="rr-viewer">
      {viewer.avatarUrl && <img className="rr-avatar" src={viewer.avatarUrl} alt="" width={28} height={28} />}
      <span className="rr-sr-only">Signed in as </span>
      <span className="rr-viewer-login">{viewer.login}</span>
      <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm" onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}
