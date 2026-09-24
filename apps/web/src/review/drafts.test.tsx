// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { openBrowserCache } from "@rendered-review/browser-cache";
import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Draft, useDrafts, useUnsentComment } from "./drafts";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

const scope = { host: "github.com", repositoryId: 42, number: 7 };
const draft = (id: string): Draft =>
  ({ id, headOid: "a".repeat(40), path: "docs/retry.md", comment: `comment ${id}` }) as Draft;

/** A page load: a fresh cache instance (memory gone), same IndexedDB. */
function load(isPrivate: boolean) {
  const cache = openBrowserCache();
  return renderHook(() => useDrafts({ ...scope, private: isPrivate }, cache));
}

it("keeps public drafts across reloads, with edits and deletions", async () => {
  const first = load(false);
  act(() => first.result.current.save(draft("d1")));
  act(() => first.result.current.save(draft("d2")));
  act(() => first.result.current.save({ ...draft("d1"), comment: "edited" }));
  act(() => first.result.current.remove(["d2"]));
  expect(first.result.current.drafts.map((d) => d.comment)).toEqual(["edited"]);

  const reloaded = load(false);
  await waitFor(() => expect(reloaded.result.current.drafts.map((d) => d.comment)).toEqual(["edited"]));
});

it("keeps drafts for private (or unknown) repositories in this tab's memory only", async () => {
  const tab = openBrowserCache();
  const first = renderHook(() => useDrafts({ ...scope, private: true }, tab));
  act(() => first.result.current.save(draft("secret")));
  // Same tab: still there when the page remounts.
  const remounted = renderHook(() => useDrafts({ ...scope, private: true }, tab));
  await waitFor(() => expect(remounted.result.current.drafts).toHaveLength(1));

  const reloaded = load(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(reloaded.result.current.drafts).toEqual([]);
});

it("keeps each pull request's drafts apart", async () => {
  const cache = openBrowserCache();
  const a = renderHook(() => useDrafts({ ...scope, private: false }, cache));
  act(() => a.result.current.save(draft("d1")));
  const b = renderHook(() => useDrafts({ ...scope, number: 8, private: false }, cache));
  await new Promise((r) => setTimeout(r, 20));
  expect(b.result.current.drafts).toEqual([]);
});

it("keeps an unsent conversation comment across reloads on public repositories only", async () => {
  const pub = load(false);
  const first = renderHook(() => useUnsentComment({ ...scope, private: false }, openBrowserCache()));
  await new Promise((r) => setTimeout(r, 20));
  act(() => first.result.current[1]("Half-written thought"));
  const reloaded = renderHook(() => useUnsentComment({ ...scope, private: false }, openBrowserCache()));
  await waitFor(() => expect(reloaded.result.current[0]).toBe("Half-written thought"));
  // Separate from the review drafts.
  expect(pub.result.current.drafts).toEqual([]);

  const secret = renderHook(() => useUnsentComment({ ...scope, number: 8, private: true }, openBrowserCache()));
  act(() => secret.result.current[1]("Private words"));
  const reloadedSecret = renderHook(() => useUnsentComment({ ...scope, number: 8, private: true }, openBrowserCache()));
  await new Promise((r) => setTimeout(r, 20));
  expect(reloadedSecret.result.current[0]).toBe("");
});
