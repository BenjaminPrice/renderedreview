// SPDX-License-Identifier: AGPL-3.0-only
// Unpublished review comments, kept in the browser per pull request until submitted.
import type { RenderedReviewAnnotationV1 } from "@rendered-review/annotation-domain";
import type { BrowserCache } from "@rendered-review/browser-cache";
import type { SourceSelection } from "@rendered-review/markdown-domain";
import type { Representation } from "@rendered-review/review-domain";
import { useEffect, useState } from "react";
import { browserCache } from "../github/client";

/** A comment added to the review. Written against `headOid`; stale once the PR head moves. */
export interface Draft {
  id: string;
  headOid: string;
  path: string;
  selection: SourceSelection;
  representation: Representation;
  /** What the reviewer wrote. */
  comment: string;
  /** The GitHub body: quote, comment, permalink where needed, annotation marker. */
  body: string;
  annotation: RenderedReviewAnnotationV1;
  createdAt: string;
}

export interface DraftScope {
  host: string;
  repositoryId: number;
  number: number;
  /** True for private repositories, or when visibility is unknown: drafts then stay in memory unless the user opted in. */
  private: boolean;
}

/**
 * The PR's drafts, from every head (compare `headOid` to find stale ones). `save` adds or replaces
 * by id. Public repositories' drafts persist in IndexedDB; private ones follow the cache's
 * private-content rule.
 */
export function useDrafts(scope: DraftScope, cache: BrowserCache = browserCache) {
  const key = `${scope.host}/${scope.repositoryId}/${scope.number}`;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => {
    let live = true;
    void cache.get<Draft[]>("drafts", key).then((stored) => live && setDrafts(stored ?? []));
    return () => {
      live = false;
    };
  }, [cache, key]);

  const update = (change: (drafts: Draft[]) => Draft[]) =>
    setDrafts((current) => {
      const next = change(current);
      void cache.set("drafts", key, next, { private: scope.private });
      return next;
    });
  return {
    drafts,
    save: (draft: Draft) =>
      update((ds) =>
        ds.some((d) => d.id === draft.id) ? ds.map((d) => (d.id === draft.id ? draft : d)) : [...ds, draft],
      ),
    remove: (ids: string[]) => update((ds) => ds.filter((d) => !ids.includes(d.id))),
  };
}
