// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { OFFLINE_HEADER, OFFLINE_SHELL } from "../sw/policy";

export const Route = createFileRoute("/")({
  // Public, user-independent page: the service worker may keep it for offline use.
  headers: () => ({ [OFFLINE_HEADER]: OFFLINE_SHELL }),
  component: Home,
});

function Home() {
  return (
    <main>
      <h1>Rendered Review</h1>
    </main>
  );
}
